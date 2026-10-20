import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ZIP_PATH = ROOT / '宝塔部署.zip'
DIST = ROOT / 'dist'

print('=== 1. Zip 文件自身 ===')
zip_stat = ZIP_PATH.stat()
print(f'  路径: {ZIP_PATH}')
print(f'  大小: {zip_stat.st_size:,} bytes')
print(f'  修改时间: {zip_stat.st_mtime}')

print()
print('=== 2. zip 内 dist 文件列表 ===')
with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    dist_files = [i for i in z.infolist() if not i.is_dir() and i.filename.startswith('dist/')]
    for f in dist_files:
        print(f'  {f.filename:60s} {f.file_size:>10,} bytes')

print()
print('=== 3. 新旧 hash 标记（判断是新包还是旧包） ===')
NEW_JS   = 'dist/assets/index-oF6q4Y4L.js'
OLD_JS   = 'dist/assets/index-CNUAkkfW.js'
NEW_CSS  = 'dist/assets/index-cRKjgzve.css'
OLD_CSS  = 'dist/assets/index-DQ5J2L77.css'
with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    names = set(i.filename for i in z.infolist())
    print(f'  新 JS 存在? {NEW_JS in names}  (index-oF6q4Y4L.js)')
    print(f'  旧 JS 存在? {OLD_JS in names}  (index-CNUAkkfW.js)')
    print(f'  新 CSS 存在? {NEW_CSS in names}  (index-cRKjgzve.css)')
    print(f'  旧 CSS 存在? {OLD_CSS in names}  (index-DQ5J2L77.css)')

print()
print('=== 4. JS 内容硬核校验 ===')
with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    js = z.read(NEW_JS).decode('utf-8', errors='ignore')
    print(f'  包含 sidebar-field-status         -> {".sidebar-field-status" in js}')
    print(f'  包含 sidebar-field-match-summary  -> {".sidebar-field-match-summary" in js}')
    print(f'  包含 sidebar-field-match-warning  -> {".sidebar-field-match-warning" in js}')
    print(f'  包含 全部字段已匹配               -> {"全部字段已匹配" in js}')

print()
print('=== 5. CSS 内容硬核校验 ===')
with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    css = z.read(NEW_CSS).decode('utf-8', errors='ignore')
    print(f'  包含 sidebar-field-status.is-matched    -> {".sidebar-field-status.is-matched" in css}')
    print(f'  包含 sidebar-field-status.is-unmatched  -> {".sidebar-field-status.is-unmatched" in css}')
    print(f'  包含 sidebar-field-label-row            -> {".sidebar-field-label-row" in css}')

print()
print('=== 6. 本地产物 vs zip 内字节比对 ===')
with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    for rel in ['dist/assets/index-oF6q4Y4L.js', 'dist/assets/index-cRKjgzve.css']:
        local_bytes = (ROOT / rel).read_bytes()
        zip_bytes = z.read(rel)
        print(f'  {rel}:')
        print(f'    本地 == zip ? {local_bytes == zip_bytes}')
        print(f'    本地 {len(local_bytes):,} bytes, zip {len(zip_bytes):,} bytes')

print()
print('=== 结论 ===')
with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    names = set(i.filename for i in z.infolist())
    js = z.read(NEW_JS).decode('utf-8', errors='ignore')
    css = z.read(NEW_CSS).decode('utf-8', errors='ignore')
    ok = (
        NEW_JS in names and OLD_JS not in names
        and NEW_CSS in names and OLD_CSS not in names
        and '.sidebar-field-status.is-matched' in css
        and '.sidebar-field-match-summary' not in js
    )
    print(f'  zip 是最新版本? {ok}')
    if not ok:
        print('  !! zip 不是最新的，重新构建 !!')
