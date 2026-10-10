"""Package the existing sidebar and field backend releases without path collisions."""

from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED


ROOT = Path(__file__).resolve().parents[1]
PARENT = ROOT.parent
SIDEBAR_BASE = PARENT / "express-delivery-deploy.zip"
SIDEBAR_UPDATE = ROOT / "express-delivery-20261008-combined-update-v2.zip"
FIELD = PARENT / "字段捷径" / "express-delivery-real-wechat-20261009.zip"
FIELD_CENTER = PARENT / "字段捷径" / "output" / "output_2026_10_8_14_09_28.zip"
GUIDE = ROOT / "docs" / "合并部署包说明.md"
OUTPUT = ROOT / "上传宝塔部署包.zip"


def entries(source: Path):
    with ZipFile(source) as archive:
        return {
            item.filename.replace("\\", "/"): archive.read(item)
            for item in archive.infolist()
            if not item.is_dir()
        }


sidebar = entries(SIDEBAR_BASE)
sidebar.update(entries(SIDEBAR_UPDATE))
field = entries(FIELD)

with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED) as result:
    for prefix, files in (("sidebar", sidebar), ("field", field)):
        for name, data in sorted(files.items()):
            if name.startswith("/") or ".." in Path(name).parts:
                raise ValueError(f"Unsafe archive member: {name}")
            if Path(name).name == ".env" or name.endswith(".pem"):
                raise ValueError(f"Secret material in archive: {name}")
            result.writestr(f"{prefix}/{name}", data)
    result.write(FIELD_CENTER, "飞书字段捷径上传包.zip")
    result.write(GUIDE, "合并部署包说明.md")

print(OUTPUT)
