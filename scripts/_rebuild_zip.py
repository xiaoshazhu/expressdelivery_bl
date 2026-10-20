from pathlib import Path
import zipfile, shutil, os, subprocess, time, sys

ROOT = Path(__file__).resolve().parents[1]
ZIP_PATH = ROOT / '宝塔部署.zip'
DIST = ROOT / 'dist'
SRC = ROOT / 'src'

def fmt(ts):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts))

# --- 1. 当前 zip 状态 ---
print('=== A. 现有 zip 状态 ===')
if ZIP_PATH.exists():
    s = ZIP_PATH.stat()
    print(f'  路径: {ZIP_PATH}')
    print(f'  大小: {s.st_size:,} bytes')
    print(f'  时间: {fmt(s.st_mtime)}')
else:
    print('  !! zip 不存在')
    sys.exit(1)

# --- 2. src/dist 文件是否有更新 ---
print()
print('=== B. 源文件时间戳（比 zip 新 = 需要重打包） ===')
zip_mtime = ZIP_PATH.stat().st_mtime
changed_files = []

for base in [SRC, ROOT/'server']:
    if base.exists():
        for f in base.rglob('*'):
            if f.is_file() and f.suffix in ('.ts','.tsx','.css','.mjs','.json','.html'):
                m = f.stat().st_mtime
                if m > zip_mtime:
                    changed_files.append((base, f, m))

for f in sorted(DIST.rglob('*')):
    if f.is_file():
        m = f.stat().st_mtime
        if m > zip_mtime:
            changed_files.append((DIST, f, m))

if changed_files:
    print(f'  发现 {len(changed_files)} 个文件比 zip 新:')
    for base, f, m in changed_files[:15]:
        print(f'    {f.relative_to(ROOT)}  ({fmt(m)})')
    if len(changed_files) > 15:
        print(f'    ... 还有 {len(changed_files)-15} 个')
else:
    print('  所有源文件时间 <= zip 时间，无需重新 build')

# --- 3. 强制 build ---
print()
print('=== C. 重新 pnpm build ===')
result = subprocess.run(['pnpm', 'build'], cwd=str(ROOT), capture_output=True, text=True)
if result.returncode != 0:
    print('  !! build 失败:')
    print(result.stderr[-2000:])
    sys.exit(1)
print('  build 完成 (exit 0)')

# 确认新 dist 文件
print()
print('=== D. 新 dist/assets 确认 ===')
assets_dir = DIST / 'assets'
for f in sorted(assets_dir.glob('*')):
    if f.is_file():
        print(f'  {f.name:40s} {f.stat().st_size:>10,} bytes  {fmt(f.stat().st_mtime)}')

# --- 4. 重建 zip ---
print()
print('=== E. 重新打包 宝塔部署.zip ===')
TMP_ZIP = ROOT / '宝塔部署.rebuild.zip'

# 读旧 zip，排除 dist/*
old_entries = []
with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    for info in z.infolist():
        if info.is_dir():
            continue
        if info.filename.startswith('dist/'):
            continue
        old_entries.append((info.filename, z.read(info.filename)))

print(f'  旧 zip 保留条目: {len(old_entries)} 个 (非 dist)')

# 新 dist 文件
new_dist = []
for p in sorted(DIST.rglob('*')):
    if p.is_file():
        rel = 'dist/' + p.relative_to(DIST).as_posix()
        new_dist.append((rel, p.read_bytes()))
print(f'  新 dist 条目: {len(new_dist)} 个')

with zipfile.ZipFile(TMP_ZIP, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in old_entries:
        z.writestr(name, data)
    for name, data in new_dist:
        z.writestr(name, data)

new_stat = TMP_ZIP.stat()
print(f'  新 zip 大小: {new_stat.st_size:,} bytes  时间: {fmt(new_stat.st_mtime)}')

# 原子替换
TMP_ZIP.replace(ZIP_PATH)
final_stat = ZIP_PATH.stat()
print(f'  已替换 -> {ZIP_PATH}')
print(f'  最终大小: {final_stat.st_size:,} bytes  时间: {fmt(final_stat.st_mtime)}')

# --- 5. 硬核校验 ---
print()
print('=== F. 硬核校验 ===')
NEW_JS  = 'dist/assets/' + list((DIST/'assets').glob('index-*.js'))[0].name
NEW_CSS = 'dist/assets/' + list((DIST/'assets').glob('index-*.css'))[0].name
print(f'  新 JS hash:  {Path(NEW_JS).name}')
print(f'  新 CSS hash: {Path(NEW_CSS).name}')

with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    names = set(i.filename for i in z.infolist())
    old_js_exists = any(n.startswith('dist/assets/index-') and n.endswith('.js') and n != NEW_JS for n in names)
    old_css_exists = any(n.startswith('dist/assets/index-') and n.endswith('.css') and n != NEW_CSS for n in names)
    print(f'  旧 hash JS 残留? {old_js_exists}')
    print(f'  旧 hash CSS 残留? {old_css_exists}')
    
    js = z.read(NEW_JS).decode('utf-8', errors='ignore')
    css = z.read(NEW_CSS).decode('utf-8', errors='ignore')
    
    checks = [
        ('.sidebar-field-status.is-matched' in css,  'CSS: 含 is-matched 样式'),
        ('.sidebar-field-status.is-unmatched' in css,'CSS: 含 is-unmatched 样式'),
        ('.sidebar-field-label-row' in css,          'CSS: 含 label-row 样式'),
        ('.sidebar-field-match-summary' not in js,   'JS: 已清除 match-summary 旧框'),
        ('.sidebar-field-match-warning' not in js,   'JS: 已清除 match-warning 旧框'),
        ('全部字段已匹配' in js,                      'JS: 含新的折叠摘要文案'),
    ]
    all_ok = True
    for ok, desc in checks:
        flag = '✅' if ok else '❌'
        print(f'  {flag} {desc}')
        if not ok: all_ok = False
    
    # 字节比对
    local_js = (ROOT / NEW_JS).read_bytes()
    zip_js = z.read(NEW_JS)
    local_css = (ROOT / NEW_CSS).read_bytes()
    zip_css = z.read(NEW_CSS)
    js_match = local_js == zip_js
    css_match = local_css == zip_css
    print(f'  {"✅" if js_match else "❌"} JS 本地 == zip ({len(local_js):,} bytes)')
    print(f'  {"✅" if css_match else "❌"} CSS 本地 == zip ({len(css_match):,} bytes)')

print()
if all_ok and not old_js_exists and not old_css_exists and js_match and css_match:
    print('🎉 宝塔部署.zip 更新完成，所有校验通过')
else:
    print('⚠️ 存在问题，请检查')
