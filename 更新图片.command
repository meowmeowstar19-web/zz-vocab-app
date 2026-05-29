#!/bin/bash
# 双击我:把新图覆盖到 public/assets/figma/ 后,运行一键发图流程。
cd "$(dirname "$0")" || exit 1
node scripts/publish-assets.mjs
echo ""
echo "（按任意键关闭窗口）"
read -n 1 -s
