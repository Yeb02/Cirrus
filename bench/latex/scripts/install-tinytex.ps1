# Installs TinyTeX-1 (pdfLaTeX) into bench/latex/vendor, never system-wide, then the preamble's packages.
$ErrorActionPreference = 'Stop'
$vendor = Join-Path (Split-Path $PSScriptRoot -Parent) 'vendor'
New-Item -ItemType Directory -Force $vendor | Out-Null
$bin = Join-Path $vendor 'TinyTeX\bin\windows'
$pdflatex = Join-Path $bin 'pdflatex.exe'

if (-not (Test-Path $pdflatex)) {
  # Latest official release; the Windows asset is a self-extracting archive.
  $release = Invoke-RestMethod 'https://api.github.com/repos/rstudio/tinytex-releases/releases/latest' -Headers @{ 'User-Agent' = 'cirrus-bench' }
  $asset = $release.assets | Where-Object { $_.name -match '^TinyTeX-1-windows-.*\.exe$' } | Select-Object -First 1
  if (-not $asset) { throw "No TinyTeX-1 Windows asset in release $($release.tag_name)" }
  $exe = Join-Path $vendor $asset.name
  Invoke-WebRequest $asset.browser_download_url -OutFile $exe
  & $exe -y "-o$vendor" | Out-Null
  if (-not (Test-Path $pdflatex)) { throw "Extraction did not produce $pdflatex" }
  Remove-Item $exe
}

# The bundled tlmgr can be older than the repository it talks to: update it first.
& (Join-Path $bin 'tlmgr.bat') update --self
& (Join-Path $bin 'tlmgr.bat') install pgf xcolor hyperref amsmath amsfonts graphics
& $pdflatex --version | Select-Object -First 1
