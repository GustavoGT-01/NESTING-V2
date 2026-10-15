; Instalador do Encaixe/Chapa (Inno Setup 6). Gere com installer\build.ps1, que monta build\app antes.
; Inclui a janela Electron, o Python portatil e o motor Rust compilado. O ODA nao e embutido (a licenca nao permite
; redistribuir): o instalador oferece baixar do canal oficial (winget ou site da ODA).

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
Name: "oda"; Description: "Instalar o ODA File Converter para abrir e gravar DWG (baixa do site oficial da ODA; DXF e SVG funcionam sem ele)"; Check: not OdaInstalled

[Files]
Source: "build\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\EncaixeChapa.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\EncaixeChapa.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; --interactive: o instalador da ODA mostra a licenca dela para o usuario aceitar
Filename: "{cmd}"; Parameters: "/c winget install --id ODA.ODAFileConverter -e --source winget --interactive"; StatusMsg: "Instalando o ODA File Converter..."; Tasks: oda; Check: HasWinget; Flags: waituntilterminated
Filename: "https://www.opendesign.com/guestfiles/oda_file_converter"; Description: "Abrir a página de download do ODA File Converter"; Tasks: oda; Check: not HasWinget; Flags: shellexec postinstall skipifsilent
Filename: "{app}\EncaixeChapa.exe"; WorkingDir: "{app}"; Description: "Abrir o {#AppName} agora"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\servidor\__pycache__"

[Code]
function OdaInstalled: Boolean;
var
  F: TFindRec;
begin
  Result := False;
  if FindFirst(ExpandConstant('{commonpf64}\ODA\*'), F) then
  try
    repeat
      if FileExists(ExpandConstant('{commonpf64}\ODA\') + F.Name + '\ODAFileConverter.exe') then
        Result := True;
    until Result or not FindNext(F);
  finally
    FindClose(F);
  end;
end;

function HasWinget: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\Microsoft\WindowsApps\winget.exe'));
end;
