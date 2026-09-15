# Acknowledgments & how to cite the tools this builds on

This workflow orchestrates several open-source projects and implements
established colocalization methods. If you publish work that uses it, please cite
the underlying software and methods as well as this workflow (see
[`CITATION.cff`](CITATION.cff)).

## Core methods software

**Cellpose** — reference-channel cell segmentation.
> Stringer, C., Wang, T., Michaelos, M., & Pachitariu, M. (2021). *Cellpose: a
> generalist algorithm for cellular segmentation.* Nature Methods, 18, 100–106.
> https://doi.org/10.1038/s41592-020-01018-x

**Cellpose-SAM** — the generalist backbone the `cpdino`/`cpsam` models build on.
> Pachitariu, M., Rariden, M., & Stringer, C. (2025). *Cellpose-SAM: superhuman
> generalization for cellular segmentation.* bioRxiv 2025.04.28.651001.
> https://doi.org/10.1101/2025.04.28.651001

**DINOv3** — the self-supervised vision backbone used by the retinal models.
> Siméoni, O., Vo, H. V., Seitzer, M., Baldassarre, F., Oquab, M., Jose, C., et
> al. (2025). *DINOv3.* arXiv:2508.10104. https://arxiv.org/abs/2508.10104
>
> Used under Meta's DINOv3 license and installed at build time; not
> redistributed in this repository.

## Colocalization methods

The reported metrics implement standard colocalization analysis; when publishing,
cite the methods you rely on:

> Manders, E. M. M., Verbeek, F. J., & Aten, J. A. (1993). *Measurement of
> co-localization of objects in dual-colour confocal images.* Journal of
> Microscopy, 169(3), 375–382. (Manders' coefficients)
>
> Costes, S. V., Daelemans, D., Cho, E. H., Dobbin, Z., Pavlakis, G., & Lockett,
> S. (2004). *Automatic and quantitative measurement of protein-protein
> colocalization in live cells.* Biophysical Journal, 86(6), 3993–4003. (Costes
> significance / automatic threshold)
>
> Dunn, K. W., Kamocka, M. M., & McDonald, J. H. (2011). *A practical guide to
> evaluating colocalization in biological microscopy.* American Journal of
> Physiology-Cell Physiology, 300(4), C723–C742.
>
> Aaron, J. S., Taylor, A. B., & Chew, T.-L. (2018). *Image co-localization – co-
> occurrence versus correlation.* Journal of Cell Science, 131(3), jcs211847.

## Scientific-Python foundation

> Harris, C. R., et al. (2020). *Array programming with NumPy.* Nature, 585,
> 357–362. https://doi.org/10.1038/s41586-020-2649-2
>
> Virtanen, P., et al. (2020). *SciPy 1.0: fundamental algorithms for scientific
> computing in Python.* Nature Methods, 17, 261–272.
> https://doi.org/10.1038/s41592-019-0686-2
>
> Hunter, J. D. (2007). *Matplotlib: A 2D graphics environment.* Computing in
> Science & Engineering, 9(3), 90–95.
>
> Paszke, A., et al. (2019). *PyTorch: An Imperative Style, High-Performance Deep
> Learning Library.* Advances in Neural Information Processing Systems 32.

Also used: scikit-image, pandas, tifffile / bioio image readers, and openpyxl.
