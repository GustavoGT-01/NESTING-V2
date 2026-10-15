; Instalador do Encaixe/Chapa (Inno Setup 6). Gere com installer\build.ps1, que monta build\app antes.
; Inclui a janela Electron, o Python portatil, o motor Rust e o conversor DWG proprio (dwgconv, ACadSharp/MIT).
; O ODA File Converter deixou de ser necessario; se o cliente ja o tiver, o programa usa como reserva.

#define AppName "Encaixe Chapa"
#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif

[Setup]
AppId={{6E1B7C52-3F0A-4D8E-9B2C-5A7D1E4F8C30}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Encaixe Chapa
DefaultDirName={localappdata}\Programs\EncaixeChapa
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=out
OutputBaseFilename=EncaixeChapa-Setup-{#AppVersion}
SetupIconFile=icone.ico
UninstallDisplayIcon={app}\EncaixeChapa.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "pt"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"

[Files]
Source: "build\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\EncaixeChapa.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\EncaixeChapa.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\EncaixeChapa.exe"; WorkingDir: "{app}"; Description: "Abrir o {#AppName} agora"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\servidor\__pycache__"
