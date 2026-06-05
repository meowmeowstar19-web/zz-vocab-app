#!/bin/bash
# 双击我 = 一键发布(工厂 → 线上)。内容工厂 Phase 3:数据/音频/图片都从「工厂」出,
# 不再往 update_data_folder 投放东西了。
#
# 用法:在工厂 ~/Desktop/data_prep 里准备好,再双击我:
#   · 改词库   → 直接改 data_prep/WordList.xlsx / PhraseList.xlsx(category 自动维护)
#   · 单词音频 → 跑 data_prep 的 4.语音生成.py 生成到 data_prep/audio/(只补缺,已上线的自动跳过)
#   · 单词图   → 跑 generate_images.py,把满意的放进 data_prep/images/word/Confirmed/
#   · 非单词图 → 直接覆盖到 public/assets/figma/(保持原名, 多大都行)
# 脚本自动:Excel 存档/压音频/重建数据/缩放压缩图/传 R2/刷新 manifest/bump 缓存/提交,
# 最后问你要不要 push 上线。只提交素材+数据,不会动你手改的代码。

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
