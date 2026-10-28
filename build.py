# Bundles the game into one self-contained HTML file: Hit The Cyclist 2.html
import re, pathlib
root = pathlib.Path(__file__).parent
html = (root / 'index.html').read_text()
css = (root / 'style.css').read_text()
html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + css + '\n</style>')
def inline(m):
    src = (root / m.group(1)).read_text()
    assert '</script' not in src.lower(), m.group(1)
    return '<script>\n' + src + '\n</script>'
html = re.sub(r'<script src="([^"]+)"></script>', inline, html)
assert 'src="' not in html and 'href="style.css"' not in html
OUT = 'Hit The Cyclist 2.html'
(root / OUT).write_text(html)
print('wrote', OUT, len(html) // 1024, 'KB')
