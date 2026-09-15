# Worker

The GPU job that runs a queued colocalization analysis end to end. For each
`Queued` run in the ELN it reads the [colocalization job](../docs/job-schema.md),
stages the images from object storage, runs the **SignalColocalization** runner
(Cellpose segmentation + colocalization metrics), uploads the workbook / CSVs / QC
overlays back to the ELN, and sets the run status.

## Files

| File | Role |
|------|------|
| `elab_analysis_worker.py` | Entry point. Claims queued Colocalization runs, runs the pipeline, writes results back. |
| `sitecustomize.py` | Makes child processes trust a self-signed ELN certificate (only for on-prem ELNs with self-signed certs). |
| `Dockerfile` | Builds the CUDA image with Cellpose + DINOv3 + the SignalColocalization runner, and bakes the models. |

## Before you build

1. **Mirror the pipeline and models** and replace the `YOUR-ORG/...` placeholders
   (see [../docs/adapting-to-your-lab.md](../docs/adapting-to-your-lab.md)).
2. Place the `SignalColocalization` package next to the `worker/` folder so the
   Dockerfile can copy and install it.

## Build

```
az acr build --registry YOUR-ACR --image coloc-worker:v1 \
  -f worker/Dockerfile --agent-pool YOUR-ACR-AGENTPOOL .
```

or with Docker:

```
docker build -f worker/Dockerfile -t coloc-worker:v1 .
```

## Run

Run the image anywhere with an NVIDIA GPU. Environment variables:

| Variable | Purpose |
|----------|---------|
| `ELAB_APIKEY` | ELN API key (provide as a secret) |
| `ELAB_BASE` | ELN API base URL, e.g. `https://eln.example.org/api/v2` |
| `BLOB_ACCT` | object-store account name |
| `UAMI_CLIENT_ID` | managed-identity client id used to read storage (Azure) |

The worker processes all currently-queued Colocalization runs, then exits — pair
it with a scale-to-zero job started on demand (see
[../reference-deployment/](../reference-deployment/)).

## Notes

- Use **experiment-** or **file-scoped** source pointers, not bare upload ids —
  some ELN APIs only serve upload binaries through an entity-scoped endpoint.
- The Cellpose models use a **DINOv3** backbone installed from Meta's repository
  at build time; it is not redistributed here — review Meta's license.
- Image readers (`bioio`/`oirfile`) and Cellpose want their own dependency
  versions; the `Dockerfile` pins a known-good combination.
