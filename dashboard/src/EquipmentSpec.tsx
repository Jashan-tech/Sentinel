import type { DbConnection } from "./module_bindings";
import type { CurrentTelemetry, RackProfile, RackProfileSource } from "./module_bindings/types";
import { EQUIPMENT_CATALOG, documentedThresholds, type CatalogEntry } from "../../spacetimedb/src/equipmentCatalog";
import { POSITION_TEXT, humidityPosition, temperaturePosition, type RangePosition } from "./equipmentView";

/**
 * Installed server for this rack: the operator picks one from the sourced catalog; the card shows the
 * manufacturer's documented environmental range next to the live reading (reference only) and offers
 * an opt-in to use that range as the rack's alert thresholds.
 */
export default function EquipmentSpec(props: {
  rackId: string;
  entry: CatalogEntry | undefined;
  profile: RackProfile | undefined;
  profileSource: RackProfileSource | undefined;
  current: readonly CurrentTelemetry[];
  disabled: boolean;
  commit: (action: (db: DbConnection) => Promise<void>) => Promise<void>;
}) {
  const { entry, profileSource } = props;
  const temp = props.current.find((r) => r.metricType === "AMBIENT_TEMPERATURE_C");
  const hum = props.current.find((r) => r.metricType === "RELATIVE_HUMIDITY_PERCENT");
  const applied = Boolean(entry && profileSource?.modelId === entry.modelId);
  const mapping = entry ? documentedThresholds(entry) : null;
  const position = (p: RangePosition) => (
    <span className={`range-pos pos-${p}`} data-position={p}>
      {POSITION_TEXT[p]}
    </span>
  );
  return (
    <section className="panel equipment-spec" aria-labelledby="equipment-spec-title" data-testid="equipment-spec">
      <div className="equipment-spec-head">
        <h2 id="equipment-spec-title">Installed equipment</h2>
        <label>
          <select
            aria-label="Installed server"
            value={entry?.modelId ?? ""}
            disabled={props.disabled}
            onChange={(e) => {
              const modelId = e.target.value;
              void props.commit((db) => db.reducers.assignRackEquipment({ rackId: props.rackId, modelId }));
            }}
          >
            <option value="">Unknown / not assigned</option>
            {EQUIPMENT_CATALOG.map((e) => (
              <option key={e.modelId} value={e.modelId}>
                {e.manufacturer} {e.model}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!entry ? (
        <p className="muted">
          Assign the server installed in this rack to see its manufacturer-documented operating range and to give
          investigations the exact model. Unknown equipment gets no model-specific guidance.
        </p>
      ) : (
        <>
          <dl className="spec-grid">
            <div>
              <dt>Standard operating temperature</dt>
              <dd>
                {entry.standardTemperatureC.min}–{entry.standardTemperatureC.max} °C
              </dd>
              <small>{entry.standardTemperatureC.note}</small>
            </div>
            <div>
              <dt>Highest documented limit</dt>
              <dd>{entry.maxDocumentedTemperatureC ? `${entry.maxDocumentedTemperatureC.value} °C` : "None above standard"}</dd>
              <small>{entry.maxDocumentedTemperatureC?.note ?? "The source documents no extended temperature class."}</small>
            </div>
            <div>
              <dt>Operating humidity</dt>
              <dd>
                {entry.operatingHumidityPercent.min}–{entry.operatingHumidityPercent.max}% RH
              </dd>
              <small>{entry.operatingHumidityPercent.note}</small>
            </div>
          </dl>
          <div className="spec-compare" aria-label="Live readings against the documented range">
            <p>
              Ambient {temp ? `${temp.numericValue} °C` : "— no reading"}{" "}
              {temp && position(temperaturePosition(temp.numericValue, entry))}
            </p>
            <p>
              Humidity {hum ? `${hum.numericValue}% RH` : "— no reading"}{" "}
              {hum && position(humidityPosition(hum.numericValue, entry))}
            </p>
            <small>
              Reference only: documented limits are for server inlet air; the rover measures ambient air near the rack.
              {" "}{entry.altitudeDerating}.
            </small>
          </div>
          <div className="spec-apply">
            {applied ? (
              <p className="spec-applied" data-testid="documented-thresholds-applied">
                ✓ This rack's alert thresholds come from this documented range. {profileSource?.mapping}
              </p>
            ) : (
              <>
                <button
                  type="button"
                  disabled={props.disabled}
                  onClick={() => void props.commit((db) => db.reducers.applyDocumentedThresholds({ rackId: props.rackId }))}
                >
                  Use documented range as thresholds
                </button>
                <small>{mapping?.mapping}</small>
              </>
            )}
          </div>
          <p className="spec-source">
            Source:{" "}
            <a href={entry.source.url} target="_blank" rel="noreferrer noopener">
              {entry.source.title}
            </a>{" "}
            · {entry.source.section}
            {entry.source.revision ? ` · ${entry.source.revision}` : ""} · accessed {entry.source.accessDate}
          </p>
        </>
      )}
    </section>
  );
}
