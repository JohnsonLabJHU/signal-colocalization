# Build & deploy the worker on Azure Container Apps

A scale-to-zero GPU job that runs the worker on demand. Fill in the `YOUR-...`
placeholders with your own resources.

## Prerequisites

- An Azure Container Registry (`YOUR-ACR`) and a Container Apps environment with a
  **GPU workload profile** (this example uses `general-gpu`, an NC8as-T4 node =
  8 vCPU / 56 GiB / one T4).
- A **user-assigned managed identity** with `AcrPull` on the registry and
  `Storage Blob Data Contributor` on the storage account.
- Your ELN reachable from the Container Apps subnet.

## 1. Build the image

From the build context (the folder containing `worker/` and your pipeline
mirrors):

```
az acr build --registry YOUR-ACR --image coloc-worker:v1 \
  -f worker/Dockerfile --agent-pool YOUR-ACR-AGENTPOOL .
```

(An in-VNet agent pool is only needed if your registry is network-locked.)

## 2. Create the job

```
UAMI='/subscriptions/YOUR-AZURE-SUBSCRIPTION-ID/resourceGroups/YOUR-IDENTITY-RG/providers/Microsoft.ManagedIdentity/userAssignedIdentities/YOUR-UAMI'
ELAB_KEY='<your analysis-worker ELN API key>'

az containerapp job create \
  --name coloc-worker --resource-group YOUR-RESOURCE-GROUP \
  --environment YOUR-CONTAINERAPPS-ENV \
  --trigger-type Manual --replica-timeout 18000 --replica-retry-limit 0 \
  --parallelism 1 --replica-completion-count 1 \
  --workload-profile-name general-gpu --cpu 8 --memory 56Gi \
  --image YOUR-ACR.azurecr.io/coloc-worker:v1 \
  --registry-server YOUR-ACR.azurecr.io --registry-identity "$UAMI" \
  --mi-user-assigned "$UAMI" \
  --secrets "elab-apikey=$ELAB_KEY" \
  --env-vars "ELAB_APIKEY=secretref:elab-apikey" \
             "ELAB_BASE=https://YOUR-ELN-HOST/api/v2" \
             "BLOB_ACCT=YOUR-STORAGE-ACCOUNT" \
             "UAMI_CLIENT_ID=YOUR-UAMI-CLIENT-ID"
```

> The API key is passed as a **secret**. Prefer sourcing it from Key Vault in
> production. Never commit it.

## 3. Start it

Manually:

```
az containerapp job start --name coloc-worker --resource-group YOUR-RESOURCE-GROUP
```

…or let the [dispatcher](../dispatcher/) start it automatically when a run is
queued.

## 4. Update to a new image

```
az containerapp job update --name coloc-worker --resource-group YOUR-RESOURCE-GROUP \
  --image YOUR-ACR.azurecr.io/coloc-worker:v2
```

## Reading logs

```
ContainerAppConsoleLogs_CL
| where ContainerGroupName_s startswith 'coloc-worker'
| order by TimeGenerated desc
```

(The worker also writes a short log into each run's record in the ELN, so most
debugging needs no cloud access.)
