"""Regenerate the embedded Google Fonts catalog in index.html.

Usage: python3 tools/gf_catalog.py path/to/google-fonts-v1.json
The JSON comes from the npm package google-font-metadata (data/google-fonts-v1.json).
Each entry is encoded as Family~category~weights, where category is one letter
(s sans, r serif, d display, h handwriting, m mono) and weights are digits 1-9 for 100-900.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAT = {'sans-serif': 's', 'serif': 'r', 'display': 'd', 'handwriting': 'h', 'monospace': 'm'}

def main(src):
    data = json.load(open(src, encoding='utf-8'))
    rows = []
    for f in sorted(data.values(), key=lambda x: x['family'].lower()):
        if 'latin' not in f.get('subsets', []) or f['category'] not in CAT:
            continue
        ws = ''.join(str(w // 100) for w in sorted(set(f['weights'])) if w % 100 == 0 and 100 <= w <= 900)
        if not ws or '~' in f['family'] or '|' in f['family']:
            continue
        rows.append(f"{f['family']}~{CAT[f['category']]}~{ws}")
    block = '/*@gf-catalog*/const GF_CATALOG = "' + '|'.join(rows) + '";/*@end-gf-catalog*/'
    p = os.path.join(HERE, 'index.html')
    s = open(p, encoding='utf-8').read()
    s, n = re.subn(r'/\*@gf-catalog\*/.*?/\*@end-gf-catalog\*/', lambda m: block, s, flags=re.S)
    if n != 1:
        sys.exit('catalog markers not found in index.html')
    open(p, 'w', encoding='utf-8').write(s)
    print(f'{len(rows)} families, {len(block)//1024} KB')

if __name__ == '__main__':
    main(sys.argv[1])
