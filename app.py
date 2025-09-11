import os
import re
import json
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Dict, List, Union

from flask import Flask, render_template, jsonify

# -----------------------------------------------------------------------------
# Flask app
# -----------------------------------------------------------------------------
app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static",
)
# 确保中文不会被转义
app.config["JSON_AS_ASCII"] = False

# 数据文件路径：环境变量优先，其次当前目录下 cleaned_total.json
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_JSON_PATH = BASE_DIR / "cleaned_total.json"
JSON_PATH = Path(os.getenv("CLEANED_JSON_PATH", DEFAULT_JSON_PATH))


# -----------------------------------------------------------------------------
# 数据清洗工具
# -----------------------------------------------------------------------------
_non_digit = re.compile(r"[^\d\.-]+")


def to_array(v: Any) -> List[str]:
    """把任意值转成字符串数组；None/空 -> []"""
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip() != ""]
    s = str(v).strip()
    return [s] if s else []


def sanitize_number(v: Any) -> int:
    """把'1,234'、' 12 345 '等转成数字；无法解析返回0"""
    if isinstance(v, (int, float)):
        return int(v)
    if v is None:
        return 0
    s = str(v).strip()
    if not s:
        return 0
    try:
        # 去掉除数字/点/负号以外字符
        s_clean = _non_digit.sub("", s)
        if s_clean in ("", "-", ".", "-.", ".-"):
            return 0
        return int(float(s_clean))
    except Exception:
        return 0


def sanitize_year(v: Any) -> Union[str, None]:
    """尝试抽取前4位年份（如 '2021-05-01' -> '2021' ）"""
    if not v:
        return None
    s = str(v)
    m = re.search(r"\d{4}", s)
    return m.group(0) if m else None


def sanitize_url(v: Any) -> str:
    """仅允许 http/https，其他返回空字符串"""
    if not v:
        return ""
    s = str(v).strip()
    try:
        p = urlparse(s)
        if p.scheme in ("http", "https"):
            return s
        return ""
    except Exception:
        return ""


def normalize_record(rec: Dict[str, Any]) -> Dict[str, Any]:
    """把一条记录规范化为前端期望的字段形态"""
    out = dict(rec)  # 浅拷贝，避免修改原对象

    # 确保关键字段存在
    out["name"] = rec.get("name", "") or ""
    out["organization"] = rec.get("organization", "") or ""
    out["organ"] = rec.get("organ", "") or ""
    out["license"] = rec.get("license", "") or ""
    out["link"] = sanitize_url(rec.get("link", "") or rec.get("homepage_url", ""))

    # 列表字段
    out["dimension"] = to_array(rec.get("dimension"))
    out["modality"] = to_array(rec.get("modality"))
    out["task"] = to_array(rec.get("task"))

    # 数值字段
    out["data_volume_total"] = sanitize_number(rec.get("data_volume_total"))

    # 年份
    year_val = sanitize_year(rec.get("year") or rec.get("release_date"))
    out["year"] = year_val if year_val is not None else ""

    return out


# -----------------------------------------------------------------------------
# 加载与处理数据
# -----------------------------------------------------------------------------
def load_and_process_data() -> List[Dict[str, Any]]:
    """加载 cleaned_total.json 并做一次性清洗"""
    if not JSON_PATH.exists():
        print(f"错误：未找到数据文件：{JSON_PATH}")
        return []

    try:
        with open(JSON_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)

        # 兼容两种顶层结构：{"rows":[...]} 或 [...]
        records = raw.get("rows", raw if isinstance(raw, list) else [])
        if not isinstance(records, list):
            print("警告：JSON 顶层结构不是列表或不含 'rows' 列表，已返回空。")
            return []

        normalized = [normalize_record(r) for r in records]
        return normalized

    except Exception as e:
        print(f"处理 JSON 时出错: {e}")
        return []


# 启动时加载一次到内存
DATASETS: List[Dict[str, Any]] = load_and_process_data()


# -----------------------------------------------------------------------------
# 路由
# -----------------------------------------------------------------------------
@app.route("/")
def index():
    """渲染主页面"""
    return render_template("index.html")


@app.route("/api/datasets")
def get_datasets():
    """返回清洗后的数据"""
    # 直接返回内存数据；若你希望每次都从磁盘重读，可改为：return jsonify(load_and_process_data())
    return jsonify(DATASETS)


@app.route("/api/health")
def health():
    """简单健康检查"""
    return jsonify({"ok": True, "count": len(DATASETS), "source": str(JSON_PATH)})


# -----------------------------------------------------------------------------
# 主入口
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    # 生产环境建议由 WSGI/ASGI（gunicorn 等）托管；开发阶段用 debug=True 即可热重载。
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
