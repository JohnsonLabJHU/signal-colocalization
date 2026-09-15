# Reference deployment

**One worked example** of the infrastructure behind the workflow, as the Johnson
Lab runs it: **eLabFTW** on a VM, **Azure Blob** for storage, and an **Azure
Container Apps** GPU job for compute. Treat this as a template to adapt — none of
it is required; the [architecture](../docs/architecture.md) is deliberately
swappable.

Everything lab-specific (subscription, resource group, account names, host, VM
IP, identity IDs) has been replaced with `YOUR-...` placeholders or moved into
`*.env` files you create locally (and which `.gitignore` keeps out of git).

## Pieces

| Folder | What it is |
|--------|-----------|
| `blob-relay/` | A tiny same-origin HTTP service the submission tool uploads through, so the **browser never holds cloud credentials**. It validates the caller's ELN session, then streams bytes to Blob using a managed identity. |
| `dispatcher/` | An always-on poller that watches the ELN for `Queued` runs and **starts the GPU job** when there is work, so nobody runs a command by hand. |
| `azure-container-apps/` | How to build the worker image and create the scale-to-zero GPU **Container Apps job**. |

## Flow

```
browser ──upload──▶ blob-relay ──▶ Blob storage
   │                                   ▲
   └─ create Queued run in ELN         │ worker stages inputs
                    │                   │
   dispatcher sees Queued ──starts──▶ Container Apps GPU job (worker)
                                        │
                    ELN ◀──results──────┘
```

## Adapting to non-Azure infrastructure

- **Storage:** swap the Blob "put block" calls in `blob-relay/` for S3
  presigned-URL or server-side uploads; point the worker's staging step at your
  store.
- **Compute:** replace the Container Apps job with AWS Batch, a Kubernetes Job, a
  SLURM submission, or just a long-running GPU box that runs the worker on a
  timer.
- **Dispatcher:** the only Azure-specific call is "start the job." Replace it
  with your scheduler's start API — or drop the dispatcher and start the job by
  hand / on a cron.

See each subfolder's notes and [`../docs/adapting-to-your-lab.md`](../docs/adapting-to-your-lab.md).
