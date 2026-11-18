![断剑蘸饭审判法庭宣传图：战术沙盘上的法庭，开黑复盘、对局档案与趣味庭审](docs/images/promo-banner.png)

<div align="center">

# 断剑蘸饭审判法庭

**打完别急着散，先来开个庭。**

**面向 Broken Arrow 朋友开黑的可视化战绩与长期数据管理工具。**<br>把对局留在本地，把小队的每一次成长留在档案里。

[![下载安装包](https://img.shields.io/badge/Download-Windows%20EXE-803d33?style=flat-square)](https://github.com/sisi4376/broken-arrow-court/releases/latest) ![Windows 10 / 11 x64](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-315d57?style=flat-square) ![内置 Node.js](https://img.shields.io/badge/Node.js-内置运行时-52744a?style=flat-square)

### [↓ 下载 Windows 一键部署程序](https://github.com/sisi4376/broken-arrow-court/releases/latest/download/BrokenArrowCourt.exe)

[发布说明与校验文件](https://github.com/sisi4376/broken-arrow-court/releases/latest) · [快速上手](#quick-start) · [完整使用手册](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md) · [反馈问题](https://github.com/sisi4376/broken-arrow-court/issues)

</div>

![审判大厅：开黑概览、地图分布与对局卷宗](docs/images/court-overview.png)

<p align="center"><sub>真实程序界面 · 基于本地档案制作的演示数据 · 玩家名称、账号 ID 与对局编号均已替换</sub></p>

## 给你们的开黑，留一份长期档案

相比直接在 BATrace 上查看战绩，法庭会将已经获取的对局数据归档到**本地 SQLite 数据库**。持续同步、保留并备份本地档案，就能逐步积累更久远的对局记录；即使某场旧对局日后无法再从上游查询，已经成功保存的内容仍可用于查看和分析。

随着档案积累，你可以按不同日期范围查看小队的胜率、分数交换、补给、专精组合和地图表现，从一晚的赛后复盘，延伸到跨月、跨版本的长期分析。一位朋友的多个游戏账号也能合并管理，让小队的历史保持连贯。

**越早开始记录，就能为以后的复盘留下越长的时间线。** 首次安装能回溯多远，仍取决于上游当时可提供的数据；本地归档不能恢复从未获取且上游已不可用的记录。

## 这局到底谁在蘸饭？

“我一直在给你送补给。”“这局分低是因为我在打防空。”“别只看胜率，看看我跟谁排的。”

如果你们的小队也有这些赛后经典台词，这个项目就是为你们准备的。把散落的对局记录整理成同一份档案：既能看长期表现，也能点进具体一局，翻到玩家、单位和装备明细。

| 赛后想问的事 | 在这里能看到什么 |
| --- | --- |
| **谁把队友的补给吃空了？** | 补给消耗、从队友获取与向队友供给分开展示；“小馋猫罪”和“运输大队长”各有榜单。 |
| **谁是真正的防空功臣？** | 重防与实际纯空优挂载战果，带单位或挂载依据；缺少证据的对局保留未知。 |
| **谁和谁一起排更顺？** | 同队搭档、专精组合与地图表现，按日期、成员、模式和开黑人数筛选。 |
| **这张兵牌到底值多少钱？** | 单位、装备挂载与参考价格明细，结合对局版本区分历史价格。 |
| **换了小号，历史怎么算？** | 一位朋友可绑定多个游戏账号，合并统计；同一个人不会被重复算成两位队友。 |
| **谁该“判”，谁能“减刑”？** | 娱乐刑期榜展示当前规则的结果与分项，个人页与榜单使用同一口径。 |

> 刑期、罪名和蘸饭指数都是朋友之间的自定义娱乐规则，不是官方实力评级。数值用于复盘和整活，不能替代对战术分工与实际回放的判断。

## 从战绩面板，到你们自己的法庭

### 有榜单，也有能翻的卷宗

总览看队伍，个人页看长期表现，单场详情看具体证据。战斗、经济、补给各有视角；摧毁分与损失分、单位击杀与损耗分别呈现。缺失详情会标出样本范围，避免把“没记录”当成“没贡献”。

![单场卷宗中的玩家战绩、经济与补给明细](docs/images/match-detail.png)

### 从一场表现，看到长期画像

个人页将一位朋友的多个账号合并，汇总长期胜率、评分变化、战斗表现与补给习惯。榜单里的每个化名背后，都有足够多的对局样本可供查看；切换日期范围，还能比较不同阶段的表现。

![使用化名的个人画像：累计对局、胜率、评分变化与娱乐判决分项](docs/images/friend-profile.png)

### 每次复盘，都有开庭的仪式感

深木色侧栏、旧纸色卷宗、酒红印章。“审判大厅”纵览开黑战绩，“看守所”管理看守所，“书记官室”负责采集和归档；从打开页面起，就是你们自己的法庭。

<table>
<tr>
<td width="74%"><img src="docs/images/court-rankings.png" alt="桌面端蘸饭罪名榜：判刑与减刑并排展示"></td>
<td width="26%"><img src="docs/images/mobile-rankings.png" alt="手机端罪名榜，适配竖屏阅读"></td>
</tr>
<tr>
<td align="center"><sub>桌面端：判刑榜与减刑榜并排查看</sub></td>
<td align="center"><sub>手机端：随手翻案</sub></td>
</tr>
</table>

### 一个人维护，全队都能看

Windows 桌面管理器负责后台启停、同步、发布和状态检查。把只读网页发布到 GitHub Pages，也可使用 Cloudflare Pages 或 EdgeOne Pages 托管；朋友打开链接就能查看，无需安装程序或登录管理后台。

采集后台在你的电脑上运行，原始数据库保存在本机。公开网页使用单独导出的快照，电脑关机后，已发布的内容仍可访问。

<a id="quick-start"></a>

## 下载后，先跑起第一场庭审

GitHub 下载包为**发布版**，采用固定采集策略：

| 项目 | 发布版规则 |
| --- | --- |
| 请求上限 | 每分钟 40 次、每小时 100 次、北京时间每日 1000 次 |
| 请求间隔 | 固定 2000 毫秒 |
| 自动同步 | 每天在北京时间 **02:00–03:00、14:00–15:00 各随机执行一次**；按天生成时间，重启不重新抽取、不重复执行 |
| 手动调取 | 每轮结束后冷却 **30 分钟**，重启后仍有效；进行中的任务不重复排队 |
| 数据源 | 默认官方源，BATrace 采集选项暂时冻结 |

自动同步仅在后台运行且自动同步开关开启时执行；离线或任务繁忙而错过的时段不补跑。额度、间隔和冷却由后台执行，不能通过界面设置修改。开发用本机版保留可调额度、原有同步安排及数据源选择，与发布包分开构建。

**推荐环境：Windows 10 / 11 x64。** EXE 内置 Node.js 24 运行时，本机使用无需另装 Node.js 或执行 `npm install`。

1. **下载并启动。** 从 [最新版发布页](https://github.com/sisi4376/broken-arrow-court/releases/latest) 下载 `BrokenArrowCourt.exe`，放在一个固定目录，双击运行。旁边没有完整项目时，程序默认释放到用户的本地应用目录，也可在管理器中选择新的空目录。
2. **创建你的管理员。** 在桌面管理器启动后台，打开本机管理页；首次访问创建管理员，没有预置密码。默认地址为 `http://127.0.0.1:4317`，实际地址以管理器显示为准。
3. **登记开黑队。** 添加朋友，使用游戏数字 ID 或 Steam64 绑定游戏账号；每人可以有多个号。默认统计“同局至少 3 位不同朋友”，需要时可切换“同队 ≥ 3 人”或“所有比赛”。
4. **同步，然后开庭。** 在书记官室中启动同步，等待已有对局逐步归档，再查看总览、个人页和卷宗。

首次回溯受上游数据完整度和限速影响，可能需要等待。自动更新需要保持本机后台运行。

<details>
<summary><strong>想把法庭链接发到群里？</strong></summary>

1. 安装 [Git](https://git-scm.com/downloads) 与 [GitHub CLI](https://cli.github.com/)，登录自己的 GitHub 账号。
2. 在桌面管理器的 **网页发布** 中填写一个独立的发布仓库，例如 `你的用户名/your-court-pages`。这个仓库存放生成的网站文件。
3. 首次部署确认要公开的数据，点击 **一键部署 Pages**，等待 GitHub 完成构建。
4. 将生成的网站链接发给队友。以后可点击 **立即更新网页**；后台也会在采集和公开数据变化后检查发布。

详细配置见 [GitHub Pages 一键部署](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md#github-deploy)。Cloudflare 与 EdgeOne 的首次账号授权和托管设置需要另行完成，见完整手册。

</details>

<details>
<summary><strong>已经有旧项目或历史数据？</strong></summary>

先备份原项目的配置和数据库。新版 EXE 可以放回已有完整项目的根目录，使用原目录的程序、配置与数据；它不会自动覆盖本地源码。需要更新已有项目时，请同时更新源码并重启后台，详见 [更新功能或样式](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md#更新功能或样式)。

只把 EXE 移到另一台电脑，不会迁移历史数据、朋友名单或 GitHub 登录。恢复步骤见 [导入、导出与备份](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md#导入导出与备份)。

</details>

## 你需要知道的几件事

- **本机能用，公开发布可选。** 不发布网页也能在本机管理和分析；持续采集需要电脑上的后台运行。Pages 承载已发布的只读快照。
- **只读页面里的内容仍然是公开数据。** 发布会包含选定范围内的朋友称呼、游戏账号、对局和单位明细；登录凭据、原始数据库、配置与备份不随网页导出。首次公开前请与朋友确认。
- **统计依赖上游记录。** 当前默认使用官方数据源，BATrace 数据源暂时冻结；覆盖范围、历史深度和详情完整度受上游影响，不能保证所有对局都能取回。
- **联网服务有可用性限制。** 首次登录、同步与发布需要联网；国内访问 GitHub Pages 等托管服务的情况因网络而异。
- **下载请认准本仓库。** EXE 尚未购买代码签名证书；发布页提供 SHA-256 校验文件。若系统拦截，请保留报错排查，不要关闭安全软件。

## 继续探索

| 想继续做什么 | 从这里开始 |
| --- | --- |
| 了解完整安装、部署与日常操作 | [使用与部署手册](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md) |
| 让群友在网页请求更新 | [可选的网页更新请求](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md#群友在公开网页请求更新可选) |
| 理解默认开黑筛选与统计口径 | [开黑口径](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md#开黑口径) |
| 查看娱乐刑期的规则和历史沿革 | [蘸饭指数与娱乐刑期](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md#蘸饭指数与娱乐刑期) |
| 配置数据库备份或迁移电脑 | [导入、导出与备份](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md#导入导出与备份) |
| 提交问题或功能建议 | [GitHub Issues](https://github.com/sisi4376/broken-arrow-court/issues) |

<details>
<summary><strong>开发者：从源码启动与验证</strong></summary>

需要 Node.js 24+。下载或克隆完整源码后，在项目根目录运行：

```sh
node --env-file-if-exists=.env src/server.mjs
```

本机程序无需安装 npm 依赖。默认本机地址为 `http://127.0.0.1:4317`；Windows 也可通过 `Start.ps1` 启动。

```sh
# 自动化测试
node --test --test-concurrency=1 test/*.test.mjs

# Windows 下构建自带运行时的桌面程序
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
```

浏览器验证需要另备 Playwright 与 Chrome/Chromium。更多目录、配置与验证方式见 [开发与验证](https://github.com/sisi4376/broken-arrow-court/blob/master/docs/USER_GUIDE.md#开发与验证)。

</details>

---

**下次有人说“这把真不怪我”，把卷宗翻出来。**

[下载最新版，给你们的小队开个庭 →](https://github.com/sisi4376/broken-arrow-court/releases/latest)
