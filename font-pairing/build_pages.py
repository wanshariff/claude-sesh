"""Build the GitHub Pages site: landing at /, lab at /app/.

Usage: python3 build_pages.py OUT_DIR
Source pages are head-less fragments (title and styles first), so each is
wrapped in a full document with meta and Open Graph tags here.
"""
import os, shutil, sys

SITE = 'https://wanshariff.github.io/claude-sesh/'
HERE = os.path.dirname(os.path.abspath(__file__))
DESC = {
    'landing': 'Generate a font pairing and an accessible color scale, preview them on real screens in 15 UI styles, and export tokens your engineers can ship.',
    'app': 'The Kernhue lab: pair fonts from Google and Adobe, build an OKLCH color scale, and preview a full website in 15 UI styles.',
}

def wrap(src, desc, url, icon):
    s = open(os.path.join(HERE, src), encoding='utf-8').read()
    i = s.index('</style>') + len('</style>')
    head, body = s[:i], s[i:]
    meta = f'''<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="{desc}">
<meta name="theme-color" content="#2b63f0">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Kernhue">
<meta property="og:title" content="Kernhue: type and color, paired and proven">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{icon}" type="image/svg+xml">
'''
    head = head.replace('<link rel="icon" href="favicon.svg" type="image/svg+xml">\n', '')
    return f'<!doctype html>\n<html lang="en">\n<head>\n{meta}{head}\n</head>\n<body>\n{body}\n</body>\n</html>\n'

def main(out):
    os.makedirs(os.path.join(out, 'app'), exist_ok=True)
    open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(wrap('landing.html', DESC['landing'], SITE, 'favicon.svg'))
    open(os.path.join(out, 'app', 'index.html'), 'w', encoding='utf-8').write(wrap('index.html', DESC['app'], SITE + 'app/', '../favicon.svg'))
    for f in ('favicon.svg', 'og.png'):
        shutil.copy(os.path.join(HERE, f), os.path.join(out, f))
    open(os.path.join(out, '.nojekyll'), 'w').close()

if __name__ == '__main__':
    main(sys.argv[1])
