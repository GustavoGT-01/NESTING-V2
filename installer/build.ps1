# Gera installer\out\EncaixeChapa-Setup-<versao>.exe
# Requisitos so na maquina de quem gera: Inno Setup 6, Rust (cargo) e Node.js (npx, para o Electron).
# Uso: powershell -ExecutionPolicy Bypass -File installer\build.ps1 [-Version 2.0.0]
param([string]$Version = "2.0.0", [string]$PythonVersion = "3.13.16", [string]$ElectronVersion = "44.7.2")
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$build = Join-Path $here "build"
$app = Join-Path $build "app"
$srv = Join-Path $app "servidor"

# 1) motor Rust atualizado
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
if (-not (Test-Path $cargo)) { $cargo = (Get-Command cargo -ErrorAction Stop).Source }
Push-Location (Join-Path $root "motor")
& $cargo build --release
if ($LASTEXITCODE -ne 0) { throw "O motor Rust nao compilou." }
Pop-Location

# 2) servidor: codigo, pagina e motor (sem os modulos em desenvolvimento: cam.py, sim.js e etiquetas.js ficam fora ate ficarem prontos)
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
New-Item -ItemType Directory -Force $srv | Out-Null
foreach ($f in "server.py", "store.py", "engine.py", "nest.py", "eps.py", "index.html", "app.js", "README.md") {
    Copy-Item (Join-Path $root $f) $srv
}
Copy-Item (Join-Path $root "motor\target\release\motor.exe") $srv

# 3) Python portatil oficial (python.org), guardado em cache
$zip = Join-Path $build "python-$PythonVersion-embed-amd64.zip"
if (-not (Test-Path $zip)) {
    Invoke-WebRequest "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $zip
}
$rt = Join-Path $srv "runtime"
Expand-Archive $zip $rt
# o ._pth fixa o sys.path; ".." poe a pasta do servidor (server.py e modulos) no caminho
$pth = Get-ChildItem $rt -Filter "python3*._pth" | Select-Object -First 1
Add-Content $pth.FullName ".." -Encoding ascii

# 4) icone e janela Electron (EncaixeChapa.exe com o icone do programa)
& (Join-Path $rt "python.exe") (Join-Path $here "icone.py")
$electron = Join-Path $build "electron"
& npx -y "@electron/packager@20.3.0" (Join-Path $root "desktop") EncaixeChapa --platform=win32 --arch=x64 `
    "--electron-version=$ElectronVersion" "--icon=$(Join-Path $here 'icone.ico')" "--out=$electron" --overwrite `
    "--app-version=$Version" "--win32metadata.ProductName=Encaixe Chapa" "--win32metadata.FileDescription=Encaixe Chapa"
if ($LASTEXITCODE -ne 0) { throw "O empacotamento do Electron falhou." }
Copy-Item (Join-Path $electron "EncaixeChapa-win32-x64\*") $app -Recurse

# 5) instalador
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 nao encontrado (winget install JRSoftware.InnoSetup)." }
& $iscc "/DAppVersion=$Version" (Join-Path $here "EncaixeChapa.iss")
if ($LASTEXITCODE -ne 0) { throw "O Inno Setup falhou." }
Get-Item (Join-Path $here "out\EncaixeChapa-Setup-$Version.exe")
