# Architecture

The workflow has four moving parts. The reference deployment uses eLabFTW and
Azure, but each box below can be swapped.

```
   ┌─────────────┐   1. upload images            ┌──────────────────┐
   │  Scientist  │ ───────────────────────────▶  │  Object storage  │
   │  (browser)  │                                │  (Blob / S3)     │
   └──────┬──────┘                                └────────┬─────────┘
          │ 2. create "Queued" run record                  │
          ▼                                                 │ 4. stage inputs
   ┌─────────────┐   3. sees queued work          ┌─────────▼─────────┐
   │     ELN     │ ◀───────────────────────────── │    GPU worker     │
   │ (eLabFTW)   │ ─────────────────────────────▶ │  Cellpose seg. +  │
   │  run record │   6. write results + status    │  colocalization   │
   └─────────────┘                                └───────────────────┘
          ▲                                                 │
          │ 5. (optional) a dispatcher starts the GPU       │
          │    job when work is queued                      │
          └─────────────────────────────────────────────────┘
```

## The four parts

**1. Submission tool** (`submission-tool/colocalization.html`)
A self-contained HTML page served from the ELN. It uploads each image to object
storage through a small **upload relay** (so the browser never holds cloud
credentials), renaming files to the lab convention via the shared
`image-uploader.js` module and creating searchable **Data files** records. It
captures the reference sets and signal channels, builds the
[colocalization job](job-schema.md), and creates a **Queued** run record.

**2. Object storage**
Holds the raw microscopy images. The reference deployment uses Azure Blob; any
S3-compatible store works. Keeping the large files here means the ELN only stores
small result files and metadata, and compute reads the images in-region.

**3. GPU worker** (`worker/`)
A container that, for each queued run: reads the job JSON, **stages** the images
from object storage, runs **Cellpose** segmentation on each reference channel,
measures **colocalization** of each signal channel inside the masks
(Manders / Pearson / Jaccard / positive fraction), **uploads** the workbook,
CSVs, and QC mask overlays back to the ELN run record and experiment, and sets the
run **Status** to Done/Failed with provenance.

**4. Dispatcher** (optional; `reference-deployment/dispatcher/`)
An always-on poller that watches the ELN for `Queued` runs and starts the GPU job
when there is work, so nobody starts it by hand. Without it, start the job
manually.

## Data model in the ELN

One **"Analysis runs"** record type holds every run, grouped into **Request**
(job type, experiment, submitter, the job JSON, sources), **Run** (status,
worker, timestamps, tool version, models), and **Results** (metrics summary +
attached files). Uploaded images are additionally recorded as **"Data files"**
entries — a searchable, backed-up archive — which lets the tool offer *"reuse an
image already in this experiment"* without re-uploading.

## Why this shape

- **The ELN is the system of record** — every analysis is an auditable entry
  linked to its experiment.
- **Storage, compute, and notebook are decoupled** — each scales or is replaced
  independently.
- **The job JSON is the single contract** — either side can be rewritten as long
  as it is honored. See [job-schema.md](job-schema.md).
