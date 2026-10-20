from pathlib import Path
import zipfile, sys, time

ROOT = Path(__file__).resolve().parents[1]
ZIP_PATH = ROOT.parent / '宝塔部署.zip'
DIST = ROOT / 'dist'
TMP_ZIP = ROOT.parent / '宝塔部署.rebuild.zip'

def fmt(ts):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts))

print('=== 重新打包 宝塔部署.zip ===')
print(f'  源 zip: {ZIP_PATH}')
print(f'  新 dist: {DIST}')
print()

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

# 收集新 dist 文件
new_dist = []
for p in sorted(DIST.rglob('*')):
    if p.is_file():
        rel = 'dist/' + p.relative_to(DIST).as_posix()
        new_dist.append((rel, p.read_bytes()))
print(f'  新 dist 条目: {len(new_dist)} 个')
for name, data in new_dist:
    print(f'    {name:50s} {len(data):>10,} bytes')

# 写入临时 zip
with zipfile.ZipFile(TMP_ZIP, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in old_entries:
        z.writestr(name, data)
    for name, data in new_dist:
        z.writestr(name, data)

# 原子替换
TMP_ZIP.replace(ZIP_PATH)
final_stat = ZIP_PATH.stat()
print()
print(f'✅ 已写入: {ZIP_PATH}')
print(f'   大小: {final_stat.st_size:,} bytes')
print(f'   时间: {fmt(final_stat.st_mtime)}')

# --- 硬核校验 ---
print()
print('=== 硬核校验 ===')
with zipfile.ZipFile(ZIP_PATH, 'r') as z:
    names = set(i.filename for i in z.infolist())
    
    # 找新 hash
    new_js = next((n for n in names if n.startswith('dist/assets/index-') and n.endswith('.js')), None)
    new_css = next((n for n in names if n.startswith('dist/assets/index-') and n.endswith('.css')), None)
    assert new_js and new_css, '找不到新 hash 文件!'
    print(f'  新 JS hash:  {Path(new_js).name}')
    print(f'  新 CSS hash: {Path(new_css).name}')
    
    # 旧 hash 残留检查
    old_js = [n for n in names if n.startswith('dist/assets/') and n != new_js and n.endswith('.js') and 'App-' not in n and 'Render' not in n and 'dist-' not in n]
    old_css = [n for n in names if n.startswith('dist/assets/') and n != new_css and n.endswith('.css')]
    print(f'  旧 hash JS 残留? {old_js or "无"}')
    print(f'  旧 hash CSS 残留? {old_css or "无"}')
    assert not old_js and not old_css, f'有旧 hash 残留! {old_js} {old_css}'
    
    js = z.read(new_js).decode('utf-8', errors='ignore')
    css = z.read(new_css).decode('utf-8', errors='ignore')
    
    checks = [
        ('.sidebar-field-status.is-matched' in css,  'CSS: is-matched 样式'),
        ('.sidebar-field-label-row' in css,          'CSS: label-row 样式'),
        ('.sidebar-field-match-summary' not in js,   'JS: 无 match-summary 旧框'),
        ('全部字段已匹配' in js,                      'JS: 新折叠摘要文案'),
    ]
    for ok, desc in checks:
        print(f'  {"✅" if ok else "❌"} {desc}')
        assert ok, f'校验失败: {desc}'
    
    # 字节比对
    local_js = (ROOT / new_js).read_bytes()
    zip_js = z.read(new_js)
    local_css = (ROOT / new_css).read_bytes()
    zip_css = z.read(new_css)
    print(f'  {"✅" if local_js == zip_js else "❌"} JS 本地 == zip')
    print(f'  {"✅" if local_css == zip_css else "❌"} CSS 本地 == zip')
    assert local_js == zip_js and local_css == zip_css

print()
print('🎉 宝塔部署.zip 更新完成，全部校验通过')
