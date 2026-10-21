# MoonTV for LG webOS

[English](README.md) · [中文](README.zh-CN.md)

给 **老款 LG webOS 电视（webOS 4.x，WebView 内核 Chrome 53）** 做的 [MoonTV / LunaTV](https://github.com/MoonTechLab/LunaTV)
遥控器友好前端。MoonTV 自带的网页前端需要 ES2018+，在这类电视上跑不起来（React 不水合、只剩文字）；本项目用纯 ES5 + flexbox
重写电视端界面，经一个小型 Python 桥接容器访问 MoonTV。

![首页](docs/screenshots/01-home.jpg)

| 分类浏览（带筛选） | 内置拼音键盘 |
|---|---|
| ![分类](docs/screenshots/02-browse.jpg) | ![拼音键盘](docs/screenshots/03-pinyin-keyboard.jpg) |

**手机当键盘** —— 扫描电视键盘旁的二维码，在手机上打字，文字直接进电视：

| 电视：键盘与二维码 | 手机：输入页 |
|---|---|
| ![电视键盘与二维码](docs/screenshots/04-phone-qr.jpg) | <img src="docs/screenshots/05-phone-input.jpg" width="260" alt="手机输入页"> |

## 功能
- **跑在 Chrome 53 上** —— 纯 ES5 + flexbox，无框架、无构建步骤；用 acorn `ecmaVersion: 5` 做语法门禁，杜绝回退。
- **为遥控器设计** —— 确定性焦点导航、大字号、深色主题；返回键（461）由 JS 接管。
- **拼音键盘** —— 欧版电视没有中文输入法，应用自带一个：全拼 / 简拼 / 前缀补全，另有来自你 MoonTV 的实时片名索引，新剧无需重装即可联想。
- **手机扫码输入** —— 键盘旁显示二维码；同一 Wi‑Fi 下手机扫码打开输入页（桥接直出，不装 App），打字后"填入"或直接"确认/搜索"。
- **多用户** —— 账号首次登录后记住，启动自动登录上次用户；顶栏登出进入类 Netflix 的用户选择页（每个用户一键进入，红键删除）；
  可通过环境变量预置账号。
- **浏览器模拟器** —— 任何电脑打开 `http://<桥接>:8788/`：等比缩放的 1920×1080"电视"跑着同一份应用，旁边是可点击的虚拟遥控器（键盘已映射）。

```
电视应用 (ES5 + flexbox, com.ting.moontv) ──JSON──▶ moontv-api（Python，Docker sidecar）──▶ MoonTV :3000
```

| 目录 | 内容 |
|---|---|
| `app/` | webOS 应用：首页海报行、分类筛选、搜索与拼音键盘、详情、播放器、多用户。见 `app/README.md`。 |
| `api/` | `moontv-api.py`：纯标准库桥接，代为登录 MoonTV，把其 API 以 CORS JSON 提供给电视（另含海报缓存、键盘用的实时片名索引、手机输入通道、模拟器托管）。附 Dockerfile 与 compose 片段。 |
| `sim/` | 浏览器电视模拟器页，由桥接在 `/sim` 提供（`/` 跳转过去）；应用本体在 `/tv/`。 |
| `tools/` | `gen_pinyin.py` 用 jieba + pypinyin 生成 `app/js/pinyin-data.js`；`build_ipk.sh` 替换桥接地址后打包。 |
| `test/` | headless Chrome 走查脚本（`walk.js`），无需电视即可在 1920×1080 下验证。 |

## 快速开始
1. **桥接** —— 把 `api/compose.snippet.yml` 合并进你的 MoonTV compose 栈（与 `moontv-core` 同一网络）。它直接从本仓库的
   GitHub 地址构建镜像，不需要本地源码；设置 `MOONTV_USER` / `MOONTV_PASS`（一个 MoonTV 登录账号），开放 8788 端口。
   独立运行：
   `docker build -t moontv-api -f api/Dockerfile https://github.com/coomteng/moontv-webos.git#main && docker run -e MOONTV_UPSTREAM=http://<moontv>:3000 -e MOONTV_USER=… -e MOONTV_PASS=… -p 8788:8788 moontv-api`。
   更新：main 有新提交后重建栈（Portainer 的 *Update the stack* 勾选 re-build）。
2. **应用** —— 写一行 `BRIDGE_BASE=http://<桥接主机>:8788` 到 `local.env`（已 git 忽略），运行 `tools/build_ipk.sh`，再
   `ares-install --device <tv> dist/*.ipk`（需要 LG Developer Mode）。详见 `app/README.md`。

不用电视也能测：浏览器打开 `http://<桥接主机>:8788/`，模拟器从同源加载应用，不需要改 `BASE`。电视上应用从 `file://`
加载，用的是打包时替换进去的 `BASE`。

为什么要桥接：应用来源是 `file://`，带不上 MoonTV 的 `SameSite=lax` 登录 cookie，MoonTV 也不接受其他认证方式；
桥接代为登录。只用 Python 标准库（可选 `pypinyin`、`qrcode`）。

## 遥控器按键
←→↑↓ 移动 · OK 确认 · 返回 上一级（键盘内：删一字/关闭）· 键盘：黄键 中/EN，红键 删除，绿键 首选，蓝键 确认/搜索，数字键 选候选。

## 安全边界
桥接没有访问控制，设计为只在家庭局域网内使用；`/seed-accounts` 会明文返回预置账号。不要把 8788 端口映射到公网。

## 许可
MIT
