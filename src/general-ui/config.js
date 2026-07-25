// general-ui config — PlushieWord 的唯一换皮文件（纪律同 miracleZZ：除本文件外，
// general-ui 的其余文件两仓逐字节整文件拷，绝不各自改）。
//
// ⚠️ 部分移植（2026-07-25 用户拍板）：PW 只接了 pop 三件 —— popKit.jsx +
// icons.jsx + 本文件。其余 general-ui 组件（Bgm/toast/sfx/Pill/Install/Feedback
// 等）尚未移植；将来要接哪件就整文件拷进来，并把它需要的 config 项补到这里。
export const YELLOW = '#FFDF4E' // 与 miracleZZ 同值；pop CTA 的主题黄

// 按钮文字字号 —— PW 全 app 按钮基准 18px（单词 pop 底部 Close、Settings 行文字
// 同为 18）；miracleZZ 配 13.5。这是换皮值，别在页面里逐个覆盖字号。
export const BTN_FONT_SIZE = 18
