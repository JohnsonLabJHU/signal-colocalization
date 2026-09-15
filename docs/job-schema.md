# The colocalization job schema

The submission tool and worker communicate through a single JSON document, the
**job**. The tool writes it into the ELN run record; the worker reads it and runs
the analysis. This is the contract.

## Example

```json
{
  "schema_version": 1,
  "sources": [
    "blob:microscopy/EXP0041/0001/retina/confocal_20x_RBPMS-Cy5+GFP-488_01.oir"
  ],
  "analysis": {
    "output_dir": "results",
    "reference_sets": [
      { "name": "RBPMS", "channel": 3, "cellpose_model": "cpdino_RPBMS",
        "diameter": null, "flow_threshold": 0.4, "cellprob_threshold": 0.0,
        "min_size": 15, "normalize": true }
    ],
    "signal_channels": [
      { "name": "dendrimer", "channel": 2, "threshold": "otsu",
        "threshold_value": null, "positive_fraction": 0.5 }
    ],
    "z_projection": "max",
    "time_index": 0,
    "scene_index": 0,
    "device": "auto",
    "save_masks": true
  },
  "execution": { "inspect": false, "save_segmentation": true }
}
```

## Fields

### `sources[]`
Pointers to the images to analyze — `blob:<container>/<path>` (or any URI your
worker's staging step understands). Prefer experiment- or file-scoped pointers
your ELN can resolve; the reference worker stages them from object storage.

### `analysis.reference_sets[]` — cell populations to outline
| Field | Notes |
|-------|-------|
| `name` | Label for the population (e.g. `RBPMS`). |
| `channel` | Channel index to segment. **0-based** (DAPI as 1st channel = `0`). |
| `cellpose_model` | Segmentation model, e.g. `cpdino_RPBMS`, `cpdino_BRN3A`, or a general model. |
| `diameter` | Expected cell diameter (px). **`null` = Cellpose infers.** Scalar. |
| `flow_threshold` | Higher → more, looser masks (default 0.4). |
| `cellprob_threshold` | Lower → more/larger masks (default 0.0). |
| `min_size` | Discard masks smaller than this many px. |
| `normalize` | Rescale image intensity before segmentation. |

### `analysis.signal_channels[]` — measured inside each mask
| Field | Notes |
|-------|-------|
| `name` | Label for the signal. |
| `channel` | Channel index to measure (0-based). |
| `threshold` | How "positive" pixels are decided: `otsu`, `percentile`, `absolute`, or `none`. |
| `threshold_value` | Number used by percentile/absolute (ignored otherwise). |
| `positive_fraction` | Fraction of a cell's area that must be positive to call the cell positive. |

Every signal channel is measured against every reference set.

### `analysis` — image handling
`z_projection` (`max`/`mean`/`first`), `time_index`, `scene_index` for
multi-dimensional files; `device` (`auto`/`cuda`/`cpu`); `save_masks`.

### `execution`
`inspect` (validate/preview only) and `save_segmentation` (write mask QC images).

## Outputs

A colocalization workbook (per-cell + per-image Manders/Pearson/Jaccard/positive
fraction), the CSVs behind it, and QC mask overlays — attached to the experiment
and the run record.

## Versioning

`schema_version` is currently `1`. Bump it for breaking changes and branch on it
in the worker so old queued runs still parse.
