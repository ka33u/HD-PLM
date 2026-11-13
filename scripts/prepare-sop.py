"""Regenerate bundled SOP previews from the verified PowerPoint originals.

Authoring only: requires LibreOffice, Poppler and Pillow. Production needs none.
Use FONTCONFIG_FILE when the renderer needs additional Chinese fonts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--soffice', default='soffice')
parser.add_argument('--pdftoppm', default='pdftoppm')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent / 'docs' / 'sop'
ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
definitions = [
    ('design', '设计部', 'technical', '建项与 BOM、阶段照片、试验分析、客户反馈和结项。'),
    ('production', '生产部', 'manufacturing', '接收项目、转采购、批量回复零件及整机完成时间。'),
    ('procurement', '采购部', 'procurement', '核对采购件、批量回复交期、确认到货和补充凭证。'),
]
catalog = []
with tempfile.TemporaryDirectory(prefix='hd-sop-render-') as temp:
    tmp = Path(temp)
    for key, department, role, description in definitions:
        source = root / f'{key}.pptx'
        subprocess.run([args.soffice, f'-env:UserInstallation={tmp.as_uri()}/lo',
                        '--headless', '--convert-to', 'pdf', '--outdir', str(root),
                        str(source)], check=True)
        subprocess.run([args.pdftoppm, '-png', '-scale-to', '2000',
                        str(root / f'{key}.pdf'), str(tmp / key)], check=True)
        pages = []
        with ZipFile(source) as z:
            slides = sorted((n for n in z.namelist()
                             if n.startswith('ppt/slides/slide') and n.endswith('.xml')),
                            key=lambda n: int(n.split('slide')[-1].split('.')[0]))
            images = sorted(tmp.glob(f'{key}-*.png'))
            assert len(images) == len(slides), 'Rendered slide count differs'
            (root / key).mkdir(exist_ok=True)
            for i, (slide, png) in enumerate(zip(slides, images), 1):
                doc = ET.fromstring(z.read(slide))
                text = [''.join(x.itertext()) for x in doc.findall('.//a:t', ns)]
                shapes = []
                for shape in doc.findall('.//p:sp', ns):
                    words = [x.text or '' for x in shape.findall('.//a:t', ns)]
                    sizes = [int(x.get('sz', '0')) for x in shape.findall('.//a:rPr', ns)]
                    if words:
                        shapes.append((max(sizes or [0]), ' '.join(words)))
                title = max(shapes, key=lambda x: x[0])[1]
                Image.open(png).convert('RGB').save(root / key / f'{i}.webp',
                                                   quality=92, method=6)
                pages.append({'title': title, 'text': '\n'.join(text)})
        files = [root / f'{key}.pptx', root / f'{key}.pdf',
                 *[root / key / f'{i}.webp' for i in range(1, len(pages) + 1)]]
        catalog.append({'id': key, 'title': f'{department}软件操作 SOP',
                        'department': department, 'role': role,
                        'description': description, 'edition': '2026.11',
                        'appliesTo': 'HD-PLM 4.2.1', 'pages': pages,
                        'assets': {str(p.relative_to(root)): {
                            'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
                            'size': p.stat().st_size} for p in files}})
(root / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
print('Generated SOP catalog and previews:', [len(x['pages']) for x in catalog])
