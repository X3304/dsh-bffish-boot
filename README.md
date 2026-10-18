# dsh-fish-boot

把 DeepSeek Harness 的开机画面换成一段视频（默认是「大肥鱼」）。

启动时全屏播放，播完淡出到应用界面；期间可以点击或按 `Esc` 跳过。

> A configurable full-screen video startup animation for **DeepSeek Harness**,
> with its own section in the app's Settings dialog. Drop in any local clip, or
> keep the bundled one. No patching of `app.asar` — it is an ordinary DSH
> plugin, so it survives app updates and uninstalls cleanly.

## 特性

- **不改 `app.asar`**：普通 DSH 插件，安装/卸载都走官方插件机制
- **任意视频**：mp4 / webm / gif / png 都行，也可以随时换回内置那条
- **可跳过**：点击画面或按 `Esc` 立刻进入应用
- **不会卡住**：自动播放被拦、文件缺失、解码失败时立刻放行；另有 120 秒硬上限
- **设置面板**：`设置 → 开机动画`，带保存 / 预览 / 重新读取 / 恢复默认
- **能跟着搬**：profile 位置从插件自己的安装路径推导，换盘、换 home 都不用改代码

## 安装

```bat
dsh plugin --profile desktop add "file:<本仓库的绝对路径>"
```

例如：

```bat
dsh plugin --profile desktop add "file:E:\code\dsh-fish-boot"
```

装完重启 DSH。打开后应该先看到大肥鱼，再进界面。

## 设置在哪

打开 DSH 的 **设置（Ctrl+,）** → 左侧最下面一栏 **开机动画**。

也可以直接改配置文件（面板上的「保存」写的就是这个文件）：

```
%DSH_HOME%\profiles\desktop\fish-boot.json
```

`DSH_HOME` 默认是 `~/.dsh`；如果你设过这个环境变量，那就是你指定的位置。

动画在**下次打开或刷新界面**时生效。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就不再播放 |
| `source` | `""` | 空 = 用插件内置的 `assets/boot-fish.mp4`；也可填绝对路径或相对 profile 目录的路径，支持 mp4 / webm / gif / png |
| `scale` | `"contain"` | `contain` 完整显示，`cover` 铺满裁切 |
| `waitForApp` | `false` | 默认播完整段。打开则**应用一准备好就淡出**，启动速度和没装插件一样，代价是视频只放一部分 |
| `minSeconds` | `0` | 这段时间内点不动，用来保证动画至少被看到 |
| `maxSeconds` | `0` | `0` = 播到结尾；设成 `2` 就只闪两秒 |
| `fadeMs` | `450` | 结束后淡出到界面的时长 |
| `loop` | `false` | 循环播放（配合 `maxSeconds` 才有意义） |
| `muted` | `true` | 关掉静音会被浏览器的自动播放策略拦截；被拦时插件会自动退回静音再试一次 |
| `skippable` | `true` | 显示「点击或按 Esc 跳过」 |
| `hideBootScreen` | `true` | 从**第一帧**就盖住原生启动屏 —— 包括视频开始前那个 `HARNESS` + 转圈。改写 index.html 实现，不等脚本加载 |
| `maskTitlebar` | `true` | **仅 Windows**：播放期间把右上角的最小化 / 最大化 / 关闭和标题栏底色一起淡掉，播完恢复。按钮仍然可以点 |
| `backgroundColor` | `"#000000"` | 黑边区域的颜色 |

## 换成自己的视频

两种方式，任选：

1. 设置面板里把「视频文件」填成你视频的绝对路径，点 **预览** 先看效果；
2. 改 `fish-boot.json` 里的 `source`。

想让**所有**装了这个插件的人都用到你的片子，就直接覆盖 `assets/boot-fish.mp4`。

## HTTP 接口

只接受本机来源（`Host` 或 `Origin` 必须是 `localhost` / `127.0.0.1`），否则 403：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/fish-boot/config` | 当前配置 + `configPath` + `videoPath` + 诊断字段 |
| `POST` | `/fish-boot/config` | 局部更新；`{"reset":true}` 恢复默认 |
| `GET` | `/fish-boot/video` | 视频本体，支持 `Range` |

## 卸载

```bat
dsh plugin --profile desktop remove dsh-fish-boot
```

或把 `dsh-fish-boot` 从 profile 的 `package.json` 的 `dependencies` 和
`dsh.profile.bundles` 里删掉，再删 `fish-boot.json`。

## 内置视频的版权

`assets/boot-fish.mp4` 是第三方作品：**「deepseek harness大肥鱼开机动画欣赏」**
（UP 主 吾为仙修，<https://www.bilibili.com/video/BV1AkWA6yEti/>）。

它**不在 MIT 许可范围内**，放在仓库里只是为了让插件开箱即用。你要公开发布的话，
建议换成自己录的片子——把 `assets/boot-fish.mp4` 删掉或在 `source` 里指定本地文件即可，
插件在没有内置视频时会直接跳过动画，不会报错。

## 许可

代码部分 MIT，见 [LICENSE](LICENSE)。
