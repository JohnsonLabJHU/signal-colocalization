# The scientist's workflow

What using the tool looks like, start to finish.

1. **Open the tool** from the lab dashboard and **pick the experiment** (a
   browse-all dropdown, filterable by title or id).

2. **Choose your images** — two ways:
   - *Option A · Upload new images.* Fill the session fields (tissue, modality,
     magnification, date), drag in a folder or browse to files (`.oir`, `.czi`,
     `.tif`, …), and complete anything flagged in the confirm table (animal,
     eye/slide, Target–Fluorophore markers) so each file is renamed to the lab
     convention. Uploading saves them to the cloud archive **and** feeds them into
     the analysis in one step. Cell-culture sessions skip animal/eye.
   - *Option B · Use images already in this experiment.* Tick images previously
     uploaded (from any tool) to analyze without re-uploading. Files already in
     the archive are detected and reused, never uploaded twice.

3. **Define what to segment and measure:**
   - A **reference set** is the cell population you outline (e.g. RBPMS to find
     retinal ganglion cells) — pick its channel and a Cellpose model.
   - A **signal channel** is what you measure *inside* those outlined cells
     (e.g. a dendrimer) — pick its channel and a threshold method.
   - Add as many of each as you need; every signal is measured against every
     reference set.

4. **Set options** (z-projection, time/scene index, device, save masks) — usually
   leave the defaults.

5. **Submit.** The run is queued; the GPU job stages the images, segments the
   cells, measures colocalization, and writes the results back.

6. **Get results.** Under *"Recent analyses on this experiment"*, each run shows
   its status (Queued → Running → Done). When Done, a **Files** button reveals an
   inline view/download panel — the Excel workbook, per-cell and per-image CSVs,
   and QC mask overlays — individually or all at once. Results are also attached
   to the experiment.

## Interpreting outputs

For each outlined cell the workbook reports **Manders' coefficients** (the
fraction of one channel's signal overlapping the other), **Pearson's**
correlation (how the two intensities co-vary — interpret alongside Manders), a
**Jaccard** overlap index, and the cell's **positive fraction**. Per-image rows
aggregate across all cells in the image. **Always check the QC mask overlays
first** — a beautiful correlation is meaningless if the masks landed on the wrong
structures. For cross-condition comparisons, consider a fixed absolute threshold
so the cutoff is identical across images.
