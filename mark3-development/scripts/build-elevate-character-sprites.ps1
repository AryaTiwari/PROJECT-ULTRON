param(
  [Parameter(Mandatory=$true)][string]$ReferencePath,
  [Parameter(Mandatory=$true)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

public static class ElevateSpriteBuilder
{
    private sealed class Def
    {
        public string Name;
        public Rectangle Rect;
        public Def(string name, Rectangle rect) { Name = name; Rect = rect; }
    }

    private static readonly Def[] Defs = new Def[]
    {
        new Def("gym_creator", new Rectangle(0, 60, 315, 755)),
        new Def("fashion_creator", new Rectangle(315, 80, 200, 735)),
        new Def("ugc_creator", new Rectangle(515, 90, 195, 725)),
        new Def("info_creator", new Rectangle(710, 80, 195, 735)),
        new Def("retention_devil", new Rectangle(905, 50, 225, 765)),
        new Def("content_doctor_female", new Rectangle(1130, 85, 180, 730)),
        new Def("content_doctor_male", new Rectangle(1310, 80, 226, 740)),
    };

    private static bool IsBackgroundCandidate(Color c)
    {
        int max = Math.Max(c.R, Math.Max(c.G, c.B));
        int min = Math.Min(c.R, Math.Min(c.G, c.B));
        return min > 218 && (max - min) < 60;
    }

    private static Rectangle ScaleRect(Rectangle rect, int width, int height)
    {
        const double baseW = 1536.0;
        const double baseH = 839.0;
        double sx = width / baseW;
        double sy = height / baseH;
        int x = Math.Max(0, (int)Math.Round(rect.X * sx));
        int y = Math.Max(0, (int)Math.Round(rect.Y * sy));
        int w = Math.Max(1, (int)Math.Round(rect.Width * sx));
        int h = Math.Max(1, (int)Math.Round(rect.Height * sy));
        if (x + w > width) w = width - x;
        if (y + h > height) h = height - y;
        return new Rectangle(x, y, Math.Max(1, w), Math.Max(1, h));
    }

    private static void RemoveConnectedLightBackground(Bitmap bitmap)
    {
        int width = bitmap.Width;
        int height = bitmap.Height;
        bool[] visited = new bool[width * height];
        Queue<int> queue = new Queue<int>(Math.Max(width, height) * 4);

        Action<int, int> enqueue = (x, y) =>
        {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            int idx = y * width + x;
            if (visited[idx]) return;
            Color c = bitmap.GetPixel(x, y);
            if (!IsBackgroundCandidate(c)) return;
            visited[idx] = true;
            queue.Enqueue(idx);
        };

        for (int x = 0; x < width; x++) { enqueue(x, 0); enqueue(x, height - 1); }
        for (int y = 0; y < height; y++) { enqueue(0, y); enqueue(width - 1, y); }

        int[] dx = new int[] { 1, -1, 0, 0 };
        int[] dy = new int[] { 0, 0, 1, -1 };
        while (queue.Count > 0)
        {
            int idx = queue.Dequeue();
            int y = idx / width;
            int x = idx - y * width;
            Color original = bitmap.GetPixel(x, y);
            bitmap.SetPixel(x, y, Color.FromArgb(0, original.R, original.G, original.B));
            for (int i = 0; i < 4; i++) enqueue(x + dx[i], y + dy[i]);
        }

        // Feather only bright pixels immediately touching transparent background.
        // This keeps white clothing intact because enclosed white regions were never flood-filled.
        List<Tuple<int,int,int>> soften = new List<Tuple<int,int,int>>();
        for (int y = 1; y < height - 1; y++)
        {
            for (int x = 1; x < width - 1; x++)
            {
                Color c = bitmap.GetPixel(x, y);
                if (c.A == 0 || !IsBackgroundCandidate(c)) continue;
                bool touches = bitmap.GetPixel(x - 1, y).A == 0 || bitmap.GetPixel(x + 1, y).A == 0 ||
                               bitmap.GetPixel(x, y - 1).A == 0 || bitmap.GetPixel(x, y + 1).A == 0;
                if (touches) soften.Add(Tuple.Create(x, y, 96));
            }
        }
        foreach (var p in soften)
        {
            Color c = bitmap.GetPixel(p.Item1, p.Item2);
            bitmap.SetPixel(p.Item1, p.Item2, Color.FromArgb(p.Item3, c.R, c.G, c.B));
        }
    }

    public static string[] Build(string referencePath, string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        List<string> outputs = new List<string>();
        using (Bitmap source = new Bitmap(referencePath))
        {
            foreach (Def def in Defs)
            {
                Rectangle cropRect = ScaleRect(def.Rect, source.Width, source.Height);
                using (Bitmap crop = new Bitmap(cropRect.Width, cropRect.Height, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(crop))
                    {
                        g.Clear(Color.Transparent);
                        g.DrawImage(source, new Rectangle(0, 0, crop.Width, crop.Height), cropRect, GraphicsUnit.Pixel);
                    }
                    RemoveConnectedLightBackground(crop);
                    string output = Path.Combine(outputDir, def.Name + ".png");
                    crop.Save(output, ImageFormat.Png);
                    outputs.Add(output);
                }
            }
        }
        return outputs.ToArray();
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing
$resolvedReference = (Resolve-Path -LiteralPath $ReferencePath).Path
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDir)
$files = [ElevateSpriteBuilder]::Build($resolvedReference, $resolvedOutput)
if ($files.Count -ne 7) { throw "Expected 7 character sprites, created $($files.Count)." }
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Character sprite was not created: $file" }
  $item = Get-Item -LiteralPath $file
  if ($item.Length -lt 512) { throw "Character sprite appears corrupt or empty: $file" }
}
Write-Output "Elevate transparent sprite pack ready: $($files.Count) sprites."
