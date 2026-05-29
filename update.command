#!/bin/bash
# 双击我 = 一键发布(图片 + 音频 + Excel 数据)。
#
# 用法:把要更新的东西放好,再双击我:
#   · 单词图 → update_data_folder/updated_image/   (文件名 = 单词, 如 apple.jpg, 多大都行)
#   · 非单词图 → 直接覆盖到 public/assets/figma/ (保持原名, 多大都行)
#   · 新音频 → update_data_folder/updated_audio/{WordList|PhraseList}/{en|zh|jp}/
#   · 改词库 → update_data_folder/WordList.xlsx / PhraseList.xlsx / category.xlsx
# 脚本自动:缩放/压缩/传 R2/刷新 manifest/bump 缓存/提交,最后问你要不要 push 上线。
# 只提交素材+数据,不会动你手改的代码。

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo "❌ 没找到 Node.js,请先装 https://nodejs.org"
    echo "（按任意键关闭）"; read -n 1 -s; exit 1
fi

node scripts/publish-all.mjs
EXIT=$?

echo ""
echo "（按任意键关闭窗口）"
read -n 1 -s
exit $EXIT
