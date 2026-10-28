# motion-lab setup for Windows. Run setup.cmd (next to this folder) or:
#   powershell -ExecutionPolicy Bypass -File share\setup.ps1
# Installs uv, ffmpeg and ImageMagick with winget, installs the `motion` command,
# downloads headless Chromium and the Kokoro voice (~340 MB), and copies the
# Claude Code skill to ~/.claude/skills/motion. Safe to run again.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User") + ";" +
                (Join-Path $HOME ".local\bin")
}

function Need($cmd, $id) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "ok   $cmd"; return }
    Write-Host "get  $cmd ($id)"
    winget install -e --id $id --accept-source-agreements --accept-package-agreements
    Refresh-Path
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "$cmd still not found after installing $id. Open a new terminal and run setup again."
    }
}

Refresh-Path
Need uv astral-sh.uv
Need ffmpeg Gyan.FFmpeg
Need magick ImageMagick.ImageMagick

Write-Host "`ninstalling the motion command..."
uv tool install --force --python 3.12 -e $Root
uv tool update-shell | Out-Null
Refresh-Path

Write-Host "`ninstalling headless Chromium for previews and export..."
$py = Join-Path (uv tool dir) "motion-lab\Scripts\python.exe"
& $py -m playwright install chromium

$models = Join-Path $Root "models"
New-Item -ItemType Directory -Force $models | Out-Null
$base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
foreach ($f in "kokoro-v1.0.onnx", "voices-v1.0.bin") {
    $dst = Join-Path $models $f
    if (Test-Path $dst) { Write-Host "ok   $f"; continue }
    Write-Host "get  $f"
    curl.exe -L --fail -o "$dst.part" "$base/$f"
    Move-Item -Force "$dst.part" $dst
}

$skill = Join-Path $HOME ".claude\skills\motion"
New-Item -ItemType Directory -Force $skill | Out-Null
$text = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot "skill\SKILL.md")
$text = $text.Replace("MOTION_LAB_DIR", ($Root -replace "\\", "/"))
[IO.File]::WriteAllText((Join-Path $skill "SKILL.md"), $text)
Write-Host "ok   Claude Code skill -> $skill"

Write-Host "`nDone. Double-click 'Open Motion Lab.cmd', or run 'motion' in a new terminal."
