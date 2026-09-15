# Adapting this workflow to your lab

This is a **reference implementation**, not a turnkey product. You will wire it to
your own ELN, object store, and compute.

## 0. What you need

- An **ELN** with a REST API. The reference uses **eLabFTW** (v2 API). Any ELN
  works if you reimplement the handful of calls the tool/worker make (create a
  record, set fields, attach files, link to an experiment).
- An **object store** — Azure Blob or any S3-compatible service.
- A place to run a **GPU container** — Azure Container Apps (reference), AWS
  Batch, Kubernetes, SLURM, or a single GPU box.

## 1. Mirror the pipeline and models (do this first)

So you don't depend on anyone's personal account:

- Fork/mirror the `SignalColocalization` pipeline into your org.
- Copy the Cellpose retinal segmentation models (`cpdino_RPBMS`, `cpdino_BRN3A`,
  …) into storage you control — your own Hugging Face org, a GitHub Release, or a
  private bucket baked into the image.
- Replace the `YOUR-ORG/...` model-repo placeholders in the worker with your
  locations.
- **DINOv3** is installed from Meta's GitHub at build time (see the `Dockerfile`).
  It is intentionally *not* redistributed here — review Meta's license.

## 2. Configure the submission tool

Edit the `CONFIG` block at the top of `submission-tool/colocalization.html`:

```js
const CONFIG = {
  API:            '/api/v2',            // your ELN REST API base
  UPLOAD_URL:     '/blobapi/upload',    // your upload relay endpoint
  BLOB_CONTAINER: 'microscopy',         // object-store container/bucket
  RUNS_STORE:     'Analysis runs',      // ELN record type for runs
  DATA_STORE:     'Data files',         // ELN record type for the file archive
  TEAM_NAME:      'your lab',           // team/group allowed to use the tool
  RECORD_VIEW_URL:'/database.php?mode=view&id=',
  HOME_URL:       '/dashboard.html'
};
```

Serve the page (and `image-uploader.js`, `results-viewer.js`) from your ELN so
they share the authenticated login session — the tool never embeds credentials.

### Note on the uploader's inventory integration

`image-uploader.js` enriches the upload form with autocomplete drawn from the
lab's inventory record types (**Animals**, **Tissue samples**, **Antibodies**) to
enforce a naming convention and link images to their sources. If your ELN doesn't
have those record types, the uploader still works — those fields simply come up
empty. Adjust the field names in `image-uploader.js` to match your schema, or
simplify the convention to what your lab needs.

## 3. The upload relay

Browsers must not hold cloud keys. The relay
(`reference-deployment/blob-relay/eln_blob_upload.py`) is a small same-origin
service that validates the caller's ELN session, then streams bytes to object
storage using a **managed identity**. Set `BLOB_ACCT` and allowed containers via
environment variables. For S3, swap the Blob "put block" calls for presigned-URL
or server-side uploads.

## 4. Build and run the worker

See `worker/README.md`. Build the container (`Dockerfile`) — it installs Cellpose
+ DINOv3 + the SignalColocalization runner and bakes the models — then run it
wherever you have a GPU. Environment variables:

| Variable | Purpose |
|----------|---------|
| `ELAB_APIKEY` | ELN API key (as a secret) |
| `ELAB_BASE` | ELN API base URL |
| `BLOB_ACCT` | object-store account |
| `UAMI_CLIENT_ID` | managed-identity client id for storage reads (Azure) |

## 5. (Optional) auto-start dispatcher

`reference-deployment/dispatcher/` polls the ELN for queued runs and starts the
GPU job. On Azure it calls the Container Apps management API via a managed
identity; on other platforms, replace that one call with your scheduler's "start
job" API — or drop the dispatcher and start the job manually.

## 6. ELN record types

Create two record types (names must match the tool's `CONFIG`):

- **Analysis runs** — Job type, Experiment ID/title, Submitted by, Date, Config
  (job JSON), Input uploads, Source pointers, Status, Worker host, timestamps,
  Tool version, Models, Metrics summary.
- **Data files** — File name, Original file name, Experiment, Blob container,
  Blob path, plus optional provenance (animal, laterality, markers, dates).

## Security notes

- Never commit real endpoints, account names, subscription/identity IDs, or keys.
  Lab-specific values live in env files (git-ignored) or the `CONFIG` block.
- The tool relies on the user's authenticated ELN session; gate it to your team.
- Build the public repo **fresh** — don't import git history from an internal
  repo, or scrubbed values may leak through old commits.
