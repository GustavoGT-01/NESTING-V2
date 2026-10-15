// Conversor DWG <-> DXF do Encaixe Chapa, com o ACadSharp (MIT). Substitui o ODA File Converter:
// o servidor chama este executável; o ODA, se estiver instalado, fica como reserva.
//
//   dwgconv to-dxf <entrada.dwg> <saida.dxf>
//   dwgconv to-dwg <entrada.dxf> <saida.dwg> [AC1015|AC1018|AC1024|AC1032]   (padrão AC1018 = AutoCAD 2004)
//
// Saída 0 = ok; 1 = uso errado; 2 = falha na conversão (mensagem no stderr).
using ACadSharp;
using ACadSharp.IO;

if (args.Length < 3)
{
    Console.Error.WriteLine("uso: dwgconv to-dxf <in.dwg> <out.dxf> | to-dwg <in.dxf> <out.dwg> [versao]");
    return 1;
}
try
{
    switch (args[0])
    {
        case "to-dxf":
        {
            CadDocument doc = DwgReader.Read(args[1], (s, e) => { });
            DxfWriter.Write(args[2], doc, false, null, (s, e) => { });
            break;
        }
        case "to-dwg":
        {
            CadDocument src = DxfReader.Read(args[1], (s, e) => { });
            var ver = args.Length > 3 && Enum.TryParse<ACadVersion>(args[3], out var v) ? v : ACadVersion.AC1018;
            // DXF mínimo (como o da exportação) não traz as tabelas padrão que o DWG exige:
            // desenho novo, completo, recebe as camadas e cópias das entidades
            var doc = new CadDocument(ver);
            foreach (var layer in src.Layers)
                if (!doc.Layers.Contains(layer.Name))
                    doc.Layers.Add(new ACadSharp.Tables.Layer(layer.Name) { Color = layer.Color });
            foreach (var ent in src.Entities)
            {
                var copy = (ACadSharp.Entities.Entity)ent.Clone();
                if (doc.Layers.TryGetValue(ent.Layer.Name, out var lay)) copy.Layer = lay;
                doc.Entities.Add(copy);
            }
            DwgWriter.Write(args[2], doc, null, (s, e) => { });
            break;
        }
        default:
            Console.Error.WriteLine("comando desconhecido: " + args[0]);
            return 1;
    }
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.GetType().Name + ": " + ex.Message);
    return 2;
}
