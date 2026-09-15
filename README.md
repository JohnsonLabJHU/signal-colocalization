# Signal Colocalization Analysis Workflow

A **self-service signal-colocalization workflow** that plugs into an electronic
lab notebook (ELN). A scientist uploads microscopy images through a simple web
form; the platform segments a reference cell population and measures
signal-channel colocalization inside each cell on a cloud GPU, then writes
auditable results back to the originating experiment. No command line, no manual
file wrangling.

Released by the **[Johnson Lab](https://www.johnsonlabjhu.com)** (Wilmer Eye
Institute, Johns Hopkins University) so other labs can adopt the same pattern. It
is the companion to our
[Calcium Imaging (GCaMP) workflow](https://github.com/JohnsonLabJHU/calcium-imaging)
and shares the same ELN-integration design.

---

## What it does

1. **Cellpose** segments a *reference* channel (e.g. RBPMS to find retinal
   ganglion cells).
2. For each outlined cell, the tool measures colocalization of one or more
   *signal* channels inside the mask — **Manders'** coefficients, **Pearson's**
   correlation, a **Jaccard** overlap index, and the positive fraction — per cell
   and per image.
3. An **Excel workbook**, per-cell / per-image **CSVs**, and **QC mask overlays**
   are written back to the experiment.

The segmentation + measurement pipeline lives in the `SignalColocalization`
package, which we mirror for long-term availability (see
[Pipelines & models](#pipelines--models)).

## Why an ELN-integrated workflow?

This project is the *plumbing* that turns analysis code into a shared lab
service: one web form captures the images and metadata, object storage holds the
raw files so the ELN never handles large images, a GPU batch job runs the
pipeline, and every run is an auditable ELN entry linked to its experiment. The
reference implementation uses **eLabFTW** and **Azure Container Apps**, but each
piece is swappable — see [`docs/adapting-to-your-lab.md`](docs/adapting-to-your-lab.md).

## Architecture at a glance

```
  Scientist ──> Submission tool (web form)
                    │  uploads images to object storage (naming convention)
                    │  creates a "queued" run record in the ELN
                    ▼
              Object storage (Blob / S3)          ELN (eLabFTW)
                    ▲                                  ▲
                    │ stages inputs                    │ writes results + status
                    ▼                                  │
              GPU worker ──> Cellpose segmentation ──> colocalization metrics
```

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/workflow.md`](docs/workflow.md).

## Repository layout

| Path | What's inside |
|------|---------------|
| [`submission-tool/`](submission-tool/) | The web form (`colocalization.html`), the shared convention-enforcing uploader (`image-uploader.js`), and the results viewer. Configure the `CONFIG` block at the top of the HTML. |
| [`worker/`](worker/) | The GPU job: stages images, runs the colocalization runner, writes results back. Includes the container `Dockerfile`. |
| [`reference-deployment/`](reference-deployment/) | One worked example: Azure Container Apps job, blob-upload relay, and dispatcher. Adapt to your infrastructure. |
| [`docs/`](docs/) | Architecture, workflow, the `colocalization-job` schema, and an adapting guide. |

## Pipelines & models

- **`SignalColocalization`** — the segmentation + colocalization runner
- **Model weights** — Cellpose retinal segmentation models (`cpdino_RPBMS`,
  `cpdino_BRN3A`, …)

> Mirrored under `JohnsonLabJHU` so the workflow does not depend on any
> individual's personal account. **DINOv3** (used by the Cellpose models) is *not*
> redistributed here — it is installed at build time under Meta's license.

## Credits

The segmentation/colocalization pipeline, trained models, and methods were
developed by **Morgan Zinn**. The ELN-integration platform was developed in the
**Johnson Lab**. Built on [Cellpose](https://github.com/MouseLand/cellpose) and
[DINOv3](https://github.com/facebookresearch/dinov3).

If you use this workflow, please cite it via [`CITATION.cff`](CITATION.cff), **and
cite the underlying methods software and colocalization methods** — full
references in [`ACKNOWLEDGMENTS.md`](ACKNOWLEDGMENTS.md).

## License

Johnson Lab platform code: **MIT** (see [`LICENSE`](LICENSE)). Dependencies keep
their own licenses — notably DINOv3 (Meta's license) and Cellpose (BSD-3-Clause).
