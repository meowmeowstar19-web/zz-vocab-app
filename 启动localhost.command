#!/bin/bash
# 双击启动本地开发服务器(localhost:5174),崩了自动重启。
# 关掉服务器:在这个窗口按 Ctrl+C(可能要按两下),或直接关窗口。

# 让 homebrew 安装的 node/npm 能被找到
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 进入项目目录(脚本所在目录)
cd "$(dirname "$0")" || exit 1

URL="http://localhost:5174"

echo "=================================================="
echo "  🚀 正在启动 localhost ..."
echo "  地址: $URL"
echo "  这个窗口别关,关了 localhost 就停了。"
echo "  要停止:按 Ctrl+C,或直接关窗口。"
echo "=================================================="
echo ""

# 5 秒后自动打开浏览器(后台执行,不挡服务器启动)
( sleep 5; open "$URL" ) &

# 无限循环:服务器崩了就自动重启
while true; do
  npm run dev
  echo ""
  echo "⚠️  服务器停了 / 崩了。2 秒后自动重启…(想彻底关掉就按 Ctrl+C)"
  sleep 2
done
