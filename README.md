# 断剑蘸饭审判法庭

朋友小队的 Broken Arrow 对局档案与分析工具。每人可登记多个游戏账号，仅统计至少三位不同朋友实际参战的对局。后台在本机持续采集，数据存入 SQLite；朋友通过独立的公开只读网站查看分析。

## 导航与部署路线

- [Windows EXE 桌面管理器](#desktop-manager)
- [本机启动与首次配置](#quick-start)
- [GitHub Pages 一键部署](#github-deploy)
- [Cloudflare Pages 部署](#cloudflare-deploy)
- [日常更新与手动发布](#updates)
- [常见部署问题](#deployment-faq)
- [配置与局域网](#配置与局域网)
- [导入、导出与备份](#导入导出与备份)

```text
BAtrace 公开数据
      |
本机 Node.js 后台 -> 私有 SQLite 数据库 -> 生成 site/ 只读快照
      |                                      |
本机管理员维护朋友、账号、同步设置             独立发布仓库
                                             |
                                  GitHub Pages / Cloudflare Pages
                                             |
                                      朋友用手机或电脑访问
```

| 部署方式 | 用途 | 必须持续运行的部分 |
| --- | --- | --- |
| 只在本机使用 | 自己管理、分析，不公开资料 | 本机后台负责采集 |
| 本机后台 + GitHub Pages | 免费公开只读网站，本项目提供一键配置脚本 | 本机后台负责新增数据，线上独立提供已发布内容 |
| 本机后台 + Cloudflare Pages | 同一静态仓库的另一种托管方式 | 与上面相同 |

**这不是把完整后台部署到 Pages。** Pages 上没有写入接口、管理员登录或持续采集进程。电脑关机后，线上最后一份快照仍可访问，但不会产生新更新。GitHub Pages、Cloudflare Pages 都不能保证中国大陆各运营商免代理稳定访问，部署成功不等于手机网络一定可达。

<a id="desktop-manager"></a>

## Windows EXE 桌面管理器

Windows 10 / 11 x64 可双击 **`BrokenArrowCourt.exe`**，不用打开终端。EXE 内置完整程序和 Node.js 24 运行时，采用 Windows 自带的 .NET Framework WinForms 界面；不是把 `.ps1` 改名为 `.exe`。构建产物不含真实 `.env`、数据库、备份、生成站点、Git 元数据或任何登录凭据。

### 当前这台电脑怎么用

1. 将 EXE 保留在现有完整项目根目录，双击启动。会自动使用该目录的 `.env` 和数据库，**不会清空或复制你的历史数据**。
2. “后台与状态”中可启动、停止、重启后台，打开管理页、只读预览或线上网站，检查 Git / GitHub CLI / 登录 / Pages 状态。
3. 已经部署过时，在“网页发布”勾选公开数据确认，点击 **立即更新网页**；再确认目标仓库后执行。过程会自动切到“运行日志”，显示进度、错误与结果，不再窗口闪退。
4. 首次部署时填写 `用户名/仓库`，需要时勾选“创建公开仓库”，再点击 **一键部署 Pages**。仍会拒绝不相关的非空仓库、不同远程地址或擅自公开私有仓库。
5. 自动推送间隔可在窗口中保存，保存后重启后台生效。关闭管理器不会停止已经启动的后台；停止后台需点击对应按钮。日志保存在项目的 `.desktop/manager.log`。

### 拷到另一台电脑怎么用

- 可以只拷贝这一个 EXE。若旁边没有完整项目，首次运行会在 `%LOCALAPPDATA%\BrokenArrowCourt\application` 释放程序，并使用那里独立的 `.env` / 数据库。也可在窗口选择一个新的空目录安装，或选择已有完整项目。**移动 EXE 不会自动迁移原电脑的历史、朋友或 GitHub 登录状态。**
- 新电脑不必单独安装 Node.js；内置运行时释放到所选项目的 `.desktop/runtime/`。原始数据库仍只在该项目的数据目录保存，不会写回 EXE。
- 发布需要该电脑有 Git 和 GitHub CLI。缺少时使用窗口中的官方下载入口安装，然后点击“检查环境与部署”。“登录 GitHub”会打开本人操作的 CLI / 浏览器授权窗口，程序不保存密码或打包 Token。
- 新项目启动后台后需在浏览器创建管理员和朋友名单。若要沿用历史，先按备份章节恢复数据库；没有恢复的独立安装不会凭空出现旧数据。
- EXE 当前没有购买代码签名证书，Windows 可能显示未知发布者。请核对文件来源；不要关闭防病毒软件或绕过系统安全拦截。如被拦截，应保留报错再排查。

EXE 支持一键 GitHub Pages 配置和静态仓库推送，不会代替 Cloudflare 的首次账号授权。已经连接同一 Git 仓库的 Cloudflare Pages 会随新提交更新。推送完成后还需等待云端构建；“检查环境与部署”可以读取 Pages 当前状态。

### 从源码重新构建 EXE

完整项目下运行（需要 Windows、x64 Node.js 24+ 和系统 .NET Framework C# 编译器，不需要 Electron/npm 依赖）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
```

输出为根目录 `BrokenArrowCourt.exe`，构建清单及中间文件在 `.cache/desktop-build/`。白名单打包公开程序文件，并对每个包内文件记录 SHA-256；不打包 `data/`、`.env`、`site/`、`.git/`、`.cache/`、`.desktop/`。重建前先关闭运行中的管理器。已有完整项目会使用原目录源码，不会用内置包悄悄覆盖本地修改。

打包的 Node.js 许可见 `desktop/NODE-LICENSE.txt`；sql.js 和 Lucide 的许可随程序保留。桌面状态层有独立单元测试；EXE 的 `--self-test 输出目录` 会在全新测试目录解包、启动/停止空后台并生成常规/紧凑窗口截图，不应使用正式数据目录作为测试输出目录。

<a id="quick-start"></a>

## 本机启动与首次配置

### 1. 准备完整项目与运行环境

- 获取完整项目目录，确认包含 `src/server.mjs`、`scripts/`、`public/`、`readonly/`、`vendor/`、`Start.ps1`。**只读发布仓库只有生成的网站文件，不能拿来运行采集后台。**
- 安装 [Node.js 24 或更新版本](https://nodejs.org/)。在终端运行 `node --version` 确认版本；安装后可能需要重新打开终端。
- 仅运行本机程序不需要 Git、GitHub CLI、npm 或 `npm install`。公开部署另外需要 [Git](https://git-scm.com/downloads) 和 [GitHub CLI](https://cli.github.com/)。
- 下文所有命令均在完整项目根目录执行，不是在 `site/` 内执行。Windows 启动脚本也支持本机已有的 Codex 捆绑 Node.js，但换电脑后应独立安装 Node.js。

### 2. 启动与创建管理员

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\Start.ps1
```

首次打开创建管理员，没有预置密码。默认地址 `http://127.0.0.1:4317`，端口被占用时自动选择下一个。`Start.ps1` 会显示并打开实际地址。

macOS / Linux 或需要查看终端日志时，前台运行：

```sh
node --env-file-if-exists=.env src/server.mjs
```

前台进程退出后不再采集；Linux 长期运行可使用自己的进程管理器，并固定工作目录为项目根目录。项目没有预置 Docker 或 systemd 一键安装器。

### 3. 配置朋友与首次同步

1. 在首次打开的页面创建管理员，没有默认密码。
2. 在“朋友与账号”添加朋友，登记各自的游戏账号；至少登记三位不同朋友才能产生符合口径的开黑统计。
3. 在“数据管理”启动同步，等待汇总、详情和涉及单位资料逐步归档。上游有请求限速，首次回溯可能较慢。
4. 打开 `http://127.0.0.1:4317/readonly/` 检查公开预览。实际端口以启动输出为准，后台每分钟检查一次是否需要生成快照。
5. 公开前确认朋友同意公开称呼、游戏账号关联与对局数据，详见后面的隐私边界。

### 停止与状态检查

```powershell
powershell -ExecutionPolicy Bypass -File .\Stop.ps1
```

服务状态：`node scripts/service.mjs status`。

配置文件修改后要停止再启动，单独再运行一次 `Start.ps1` 只会复用已运行的服务，不会加载新配置。首次使用可在文件不存在时复制 `.env.example` 为 `.env`；**已有 `.env` 不要覆盖**。

## 建立朋友名单

1. 管理员在“朋友与账号”添加真实的朋友，每个人只建一份朋友记录。
2. 每位朋友可以登记多个游戏账号。支持名称、Steam64 ID、Steam 主页或 BATrace 玩家链接搜索，也可以直接登记游戏内数字 ID。
3. 用朋友行上的邀请按钮生成邀请码，朋友注册后会认领已有记录，不会多生成一个人。全局“邀请注册”会新增一位朋友。
4. 管理员可以调整游戏账号归属，朋友可以管理自己的账号。账号全局唯一，避免同一个账号被计入两个人。

登记仅建立分析归属，不验证 Steam 账号所有权。本站登录账号和游戏账号是两种不同的账号。

## 开黑口径

总览、对局档案和开黑分析默认筛选“普通模式”，可切换“全部模式”查看其他模式；清除筛选时恢复普通模式。BAtrace 省略的 `Type=0` 会按普通模式识别，旧数据库自动修正，真正未知来源的模式不会被强行归类。

- 同一局至少 **3 位不同的启用朋友**实际参战，才纳入法庭统计。
- 同一人的多个游戏账号，人数只计一位。
- 按用户要求，朋友分处两边也属于同一局开黑；“同队至少三人”是额外筛选，不是默认口径。
- TeamId 100 的观战者不计入参战朋友。
- 归属调整、停用或恢复后，历史记录立即重算。
- 同一人多账号参与一局时，成员局数只计一次，分数相加；如果两边都有其账号，该成员该局胜负记为未知。
- 分数交换比是摧毁分 / 损失分，和单位数量 K/D 分开。
- 朋友表现中的摧毁分、损失分、占点和友伤均为场均值。同一朋友同局多账号先合并再平均；友伤仅以详情完整的场次作为分母，缺失详情不记为零，并显示样本局数。评分变化仍为累计变化，单场详情仍显示该局实际值。
- 生涯统计明确独立展示，包含单排，不会混入法庭的三人开黑统计。

### 战斗、经济与补给分析

- 总览和“开黑分析 → 朋友表现”均可切换战斗、经济、补给。经济显示场均出场分数、退款分数、击毁 / 损失数量和经验；补给显示场均消耗补给、补给队友、从队友补给。单场详情仍显示该局实际值。
- “开黑分析 → 补给分析”的 **小馋猫榜** 按场均消耗队友补给（`SupplyPointsConsumedFromAllies`）降序；**运输大队长榜** 按场均补给队友（`SupplyPointsConsumedByAllies`）降序。不是按累计量排行，相同均值并列。
- 补给和经济仅用详情完整的合格对局计算。同一朋友同局多个账号先相加，再按朋友的有效局数平均；缺失详情不记为零，完整 protobuf 详情省略的零值按零计算。队友指所有同队玩家，不仅是登记的朋友；上游没有逐人补给流向，不能据此判断具体是谁补给了谁。
- 补给榜默认至少 5 局完整详情，可调整“补给榜最低完整局数”；“同队搭档”默认至少 5 局共同同队对局，可调整“同队搭档最低局数”。两项门槛各自独立，均遵从当前日期、模式、地图等筛选；胜率仍以已知结果为分母。
- 已归档完整详情会直接参与新统计，无需重新抓取或迁移数据库。公开只读站点使用相同计算逻辑，更新源码后重新导出 / 发布即可。

## 朋友详细分析与专精组合

在“朋友与账号”点击“详细分析”，或在总览 / 开黑分析中点击朋友姓名，进入该朋友的分析页。六个分页包含综合画像、专精组合、队友关系、地图表现、常用单位和最近对局。日期、地图、模式和队伍条件共同生效，默认仍为普通模式；所有统计只使用合格开黑局。

朋友表现、同队搭档，以及个人 / 总体的专精组合、地图、组合与地图交叉表、常用单位均支持点击列名排序。再次点击切换升序 / 降序，箭头显示方向；名称默认升序，多数数值默认降序，损失、阵亡和友伤默认升序。缺失数据始终排在末尾，零值和无限交换比按真实数值比较；相同值保持原有顺序。各表在当前浏览器标签页内分别记住排序，筛选、切换栏目或刷新后继续生效，点击“恢复默认”可清除。列排序不改变最佳 / 最差排行的样本门槛，同队搭档排序使用全部符合筛选的组合。

- 同一朋友多账号同局合并；分处两队时，胜负和队友关系不明确的部分不强行归类。队友表区分同局、同队和对位，并展示同队胜率、个人评分变化及对位胜率。
- 最佳 / 最差搭档按同队胜率排名，默认至少 5 局结果已知，可切换为 1、3、10、20 局。样本不足的行仍展示；胜率差只是对照，不代表因果。
- 常用单位按出场局数排序，也可按出场次数或总伤害排序；同局重复部署增加出场次数，不增加出场局数。使用率只以完整详情的参战场次为分母，“使用时胜率”是使用该单位的对局胜率。
- 单场原始数据没有直接给出专精组合。程序使用公开卡组编辑器的单位池及 `availability.spec1/spec2` 建立专精映射，仅在出场单位对应唯一的同国两专精组合时显示“推定”。目录版本、未出场单位及转让单位可能影响结果；无法唯一识别的记录不强行分配组合。
- 管理员或账号所属朋友可在单场“团队战绩”中确认 / 修正专精组合，人工确认优先于推定，并在后续同步时保留。不同账号采用不同组合的同一朋友同局记录，整体组合暂记为未确认。只读公开版不提供修改入口。
- 总体“专精组合”“地图胜率”及“组合 × 地图”按朋友参战人次统计；同一朋友同局最多计一次。朋友分处两队时双方都会纳入，所以这里不是把整局开黑定义成一次共同胜负。

专精目录已保存于数据库。需要更新当前公开目录时，在项目目录运行 `node scripts/update-analysis-catalogue.mjs`；此操作先备份数据库，仅保存已归档单位相关的映射，不下载全部单位详情。缺少目录时分析页仍可使用，组合显示为未确认。SQLite 完整备份包含人工确认和目录。GitHub Pages / 只读导出也支持同样的分析和筛选。

## 数据获取与持续更新

地图名称统一由后端提供，筛选、分布、列表和详情使用同一份映射，不改写历史 `MapId`。2026-10-16 将游戏客户端场景加载日志的 FID 与 BAtrace 同局原始数据核对：对局 [8535061](https://dash.batrace.top/match/8535061) 的 27 = Daugavpils（陶格夫匹尔斯），对局 [8557841](https://dash.batrace.top/match/8557841)、8566476 的 28 = Coal Mountain（煤山）。25 = Kadaga Military Base（卡达加军事基地）目前依据 [Aqualung 地图索引](https://ba.aqualung.dev/data/maps/index.json)，尚未完成同局日志核验，不与前两项视为同等证据。24、26 保留 BAtrace 旧目录名称，未据此确认实际场景，也不和其他编号合并统计；其他未知编号不臆测名称。游戏原始日志仅用于本机核验，不随网站发布。

默认数据源为 `https://dash.batrace.top`。使用公开网页正常调用的只读端点和公开的服务端渲染数据，不需要游戏登录凭据。

| 内容 | 来源 | 保存内容 |
| --- | --- | --- |
| 玩家搜索 | `/api/players/search` | 游戏 ID、Steam64、名称、评分等 |
| 玩家档案 | `/player/{id}` | 完整 `playerData`，包括生涯分模式统计、补给、国家/专精经验、勋章、地图场次等 |
| 对局列表 | `/api/players/matches` | 分页列表及全部原始赛后汇总 |
| 单场详情 | `/match/{id}` | 全部玩家字段、经济、经验、友伤、补给、勋章、单位实例、改装、出场/阵亡、伤害/击杀、转移单位等 |
| 涉及单位资料 | `/api/dek/units/batch` | 已归档对局涉及的单位资料；没有扫描整个单位库 |

默认每 15 分钟同步，每次请求间隔至少 1.8 秒。首次回溯所有注册账号当前可查询的历史，按对局 ID 去重，随后增量更新，每周再次扫描历史窗口。每个账号独立保存游标、上游数量、失败重试时间。每轮每个账号至多 200 页，未完成的下轮继续，不固定截断为 100 场。完整详情优先抓取已满足三人条件的对局，每轮最多 250 局。

上游 `totalCount` 可能包含仍在历史索引中、但已不再返回比赛数据的 ID。遇到短页或空页时，程序会刷新玩家历史索引并重复核对该页，按索引位置继续翻页，不因缺失比赛提前停止。确认缺失的 ID 单独保存，界面显示“已同步 · 历史有缺失”及数量，每周回扫或手动全量回溯时再次检查；网络错误、索引不一致仍显示同步异常。后续从其他朋友或导入档案找回比赛时，缺失标记自动解除。

出现 429 或 403 会遵守冷却，不绕过访问验证。网络及结构解析失败会记录到日志，保留已有数据和进度。使用“全量回溯”可以重新检查当前所有可访问历史，不会清空旧档案。

**历史边界：** 实测某账号生涯超过 500 场，而上游历史列表只列出 100 场。程序能保存各朋友账号历史窗口的并集，并不断积累，但无法恢复数据源已不再提供的旧记录。不能保证所有生涯比赛都能追回。对局详情也可能过期；界面分别显示汇总、完整详情和失败状态。

更早历史仍可能从其他已登记小号的记录窗口，或已有对局链接、JSON、HTML 归档中补入。没有对局 ID 或其他档案时，不会遍历全站猜测 ID。若站方提供授权的历史导出或兼容接口，可继续接入；生涯累计统计不能还原每场记录。

“数据管理 → 按 ID 补抓”支持数字对局 ID 或 BATrace 单场链接，直接尝试抓取完整详情，不依赖最近 100 场列表。成功后同样按三人条件判定；不足三人的记录只作为候选保存。链接对应的详情已过期时会提示失败，不会伪造历史。

**覆盖边界：** 已确认并实现单场及玩家相关的公开数据读取。BATrace 的社区投稿、举报、站内好友图谱鉴权和全站单位库不是本工具的采集范围。不是 BATrace 官方接口客户端，页面或内部 API 变化后可能需要更新解析器。持续长期使用应与站方确认访问频率及接口使用方式。

## 导入、导出与备份

管理员在“数据管理”导入 JSON / HTML：

- BATrace 分页对局响应 `{ "matches": [{ "matchId": "...", "data": {...} }], "totalCount": ... }`。
- `{ "matchMap": { "对局ID": {...} } }`、单条 `{ "matchId": "...", "data": {...} }` 或对应对象数组。
- 本工具导出的 `broken-arrow-court-v1` 完整档案 JSON。
- 保存的公开玩家页 HTML，或者单场 HTML（填写对局 ID）。

导入前校验所有对局，单次导入事务提交；无效文件不会留下部分结果。原始字段和未知字段完整保存，按 ID 更新去重。JSON 导入不覆盖用户和朋友归属；完整迁移使用 SQLite 备份。

主数据库为 `data/court.sqlite`，采用 WAL、外键、索引、事务和版本化初始化。`data/backups/` 每日自动保存一致性备份，保留 14 天。管理员可以随时下载一致性数据库备份或导出原始 JSON。所有不同版本的源响应以 gzip 存入 `source_snapshots`，同一内容去重，供以后重算和审计。

恢复完整备份：先用 `Stop.ps1` 停止服务，把当前 `data` 目录整体另存；把备份放入一个**新的空数据目录**并命名为 `court.sqlite`，设置 `.env` 中 `DATA_DIR` 指向该目录后重新启动。不要覆盖仍在运行的数据库，不要将旧的 `-wal`、`-shm` 文件和恢复文件混用。备份包含密码哈希和会话，按私有文件保管。

## 公开版的隐私边界

公开版是独立静态网站，不需要访客连接本机后台。浏览器使用 sql.js 1.15.0（MIT）查询重新生成的只读索引，索引压缩传输，单场详情按需加载。游戏明细采用字段白名单，不等同于私有原始档案的全字段导出。

| 可以公开的生成内容 | 不会导出的私有内容 |
| --- | --- |
| 满足三人条件的对局、参赛者游戏名和游戏 ID、战绩及单位明细 | 不符合条件的候选单排记录 |
| 启用朋友的称呼、登记的游戏账号及其关联、已确认专精组合 | 本站登录名、密码哈希、会话、邀请码、确认操作人的身份 |
| 静态脚本、样式、只读索引和目录 | Steam64 字段、原始数据库、备份、原始网页、同步日志、`.env` |

**只读不等于保密。** 访客不能注册、修改账号归属、确认专精、导入或调整同步设置，但可以下载公开索引和对局明细。公开仓库的文件及历史提交也可以被下载。以后删去朋友或改成私有，不能收回别人已经下载的资料，也不会自动清除 Git 历史。

只公开 `site/` 中受管的生成文件。不要把完整项目、`data/`、数据库备份或 `.env` 上传到公开仓库。发布器会建立独立的 `site/.git`，不使用项目根目录的 Git 仓库，不执行 `git add .`，也不强制推送。

<a id="github-deploy"></a>

## GitHub Pages 一键部署

这里的“一键”指：完成工具安装和本人登录后，一条命令串起首次静态发布；不绕过登录、验证码或组织授权。脚本支持 GitHub.com 的独立公开仓库、`main` 分支、仓库根目录发布。

### 1. 安装工具并登录（只做一次）

安装 Node.js 24+、Git、GitHub CLI，重新打开终端后检查：

```powershell
node --version
git --version
gh --version
gh auth login --hostname github.com --git-protocol https --web
```

按 GitHub CLI 提示由本人完成浏览器授权；不要把密码、Token 发给别人，也不要放进仓库 URL。登录状态可用 `gh auth status` 检查。

### 2. 执行一键部署

**Windows 直接双击 `Deploy-GitHubPages.cmd`**，会保留终端窗口并依次询问仓库地址、公开数据确认、是否允许创建公开仓库以及是否重启本机服务。已有 `.env` 发布配置时，仓库输入直接按回车。确认问题默认均为否，输入 `y` 才同意；首次部署前仍需完成上一节的安装和登录。

不要直接双击 `.ps1`：Windows 可能仅用编辑器打开它，或报错后窗口立即关闭。双击入口使用 `.cmd`；下方 PowerShell 命令用于已经打开的终端，无需重复答题。

把下面的 `your-name` 替换成自己的 GitHub 用户名，仓库名建议保留为 `broken-arrow-court-public`。仓库应专用于生成网站，不与后台源码混用。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy-GitHubPages.ps1 -Repository your-name/broken-arrow-court-public -CreatePublicRepository -AllowPublicData -RestartService
```

参数含义：

| 参数 | 含义 |
| --- | --- |
| `-Repository OWNER/NAME` | 指定发布目标；省略时使用 `.env` 已配置的 GitHub 仓库 |
| `-CreatePublicRepository` | 仓库不存在时明确允许创建**公开仓库**；已存在则复用，不重复创建 |
| `-AllowPublicData` | 明确同意公开前述朋友称呼、账号关联和游戏数据；不加就不会部署 |
| `-RestartService` | 成功后重启本机后台，加载自动发布配置；不加则需自己重启 |

本机已经配置好发布仓库时，可以直接重复执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy-GitHubPages.ps1 -AllowPublicData -RestartService
```

macOS / Linux 使用同一部署逻辑：

```sh
node scripts/deploy-github-pages.mjs --repository your-name/broken-arrow-court-public --create-public-repository --allow-public-data --restart-service
```

脚本会检查登录、仓库与输出目录，重新导出只读快照，只为生成仓库设置 GitHub CLI 凭据助手，然后提交、推送并启用 Pages（`main` / `/`）。成功后保留 `.env` 中其他设置，仅更新发布相关项。重复执行不会重置数据库或朋友名单。

安全限制：不会擅自把私有仓库改为公开；不会覆盖不同远程仓库、已有其他 Pages 构建方式或不相关的非空仓库。已有发布配置指向别处时会停止，不自动改投新仓库。为另一群朋友部署应使用新的完整项目目录及独立数据库、空发布仓库，不要复制旧的 `.env`、`data/`、`site/` 后直接发布。

### 3. 确认部署成功

脚本输出 `url` 和配置结果，只代表推送、Pages 配置成功，**不是构建已经完成的保证**。进入 GitHub 仓库的 **Actions** 查看 Pages 工作流，或在 **Settings → Pages** 查看部署地址和状态。也可以运行：

```powershell
gh api repos/your-name/broken-arrow-court-public/pages/builds/latest --jq .status
```

状态为 `built` 后打开脚本返回的 HTTPS 地址，通常是 `https://your-name.github.io/broken-arrow-court-public/`。用桌面和手机分别验证首页、模式/地图筛选、朋友分析和单场详情。不要只检查首页是否返回 200。

### 不用脚本：手动配置

1. 在 GitHub 创建独立空仓库，不添加 README、许可证或 `.gitignore`。免费 Pages 使用公开仓库；GitHub Pro 等套餐可从私有仓库发布，网站本身也不因此自动私有。
2. 在本机 `.env` 中填写下节的发布设置。已有文件只修改对应项，不要整份覆盖。
3. 配好 Git HTTPS 凭据或 SSH，运行 `node scripts/publish-site.mjs` 首次推送。
4. 在仓库 **Settings → Pages → Build and deployment**，选择 **Deploy from a branch**，分支选 `main`，目录选 `/(root)`，保存。
5. 停止再启动本机后台，等待 Pages 构建完成。生成站点自带 `.nojekyll`，支持仓库子路径，无需添加前端构建命令。

参考：[GitHub Pages 发布源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)、[套餐与可见性](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[GitHub Pages API](https://docs.github.com/en/rest/pages/pages)。

<a id="cloudflare-deploy"></a>

## Cloudflare Pages 部署

可以和 GitHub Pages 使用同一个静态仓库，也可以只选 Cloudflare。Cloudflare Git 集成支持公开或私有仓库，私有仓库不代表发布网站私有。此处没有承诺“免登录一键创建 Cloudflare 项目”：首次 GitHub 授权需要你在 Cloudflare 中完成。

1. 准备一个已推送静态文件的独立仓库。如果只用 Cloudflare 且希望仓库私有，可以先手动创建私有空仓库，再按下节配置本机发布；不要运行只支持公开仓库的一键 GitHub Pages 脚本。
2. 登录 Cloudflare，进入 **Workers & Pages → Create application → Pages → Connect to Git / Import an existing Git repository**。选择 Pages，不是 Workers，也不是手动拖放上传模式。
3. 授权 GitHub 时尽量使用 **Only select repositories**，只选择静态发布仓库，避免授权整个账号的所有仓库。
4. 选择仓库，按下表填写配置，再点击 **Save and Deploy**。

| Cloudflare 设置 | 值 |
| --- | --- |
| 项目名称 | 例如 `broken-arrow-court-public`，重名时自行换名 |
| 生产分支 | `main` |
| 框架预设 | `None` |
| 构建命令 | `exit 0`（仓库已经是构建产物） |
| 构建输出目录 | `/`（不是 `site`，因为远程仓库根目录就是导出内容） |
| 根目录（高级） | 留空 |
| 环境变量、数据库、后台地址 | 均不需要 |

5. 等部署成功，打开项目提供的 `https://项目名.pages.dev/`，检查页面和数据。下次本机向 `main` 推送新提交，Cloudflare 会自动部署。

`_headers` 为支持该文件的托管平台提供缓存和安全策略；GitHub Pages 不会应用 Cloudflare 的 `_headers` 配置。自定义域名可以在 Pages 项目中另外配置，但不能保证解决大陆网络的速度或可达性问题。

参考：[Cloudflare Git 集成](https://developers.cloudflare.com/pages/get-started/git-integration/)、[静态 HTML 部署](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)。

<a id="updates"></a>

## 日常更新与手动发布

### 自动更新

在本机 `.env` 设置以下发布项，随后重启后台：

```dotenv
STATIC_EXPORT_ENABLED=1
STATIC_OUTPUT_DIR=./site
PUBLISH_GIT_REMOTE=https://github.com/your-name/broken-arrow-court-public.git
PUBLISH_GIT_BRANCH=main
PUBLISH_MIN_INTERVAL_MINUTES=120
```

默认采集约每 15 分钟执行一轮，静态导出约每分钟检查一次，有公开内容变化才生成新版本；两次自动推送至少间隔 120 分钟以合并变化，不是每次采集后立即上线。托管平台随后还需要完成部署。没有新版本就不会制造空提交或无效构建。请求失败、限流或电脑休眠会延迟更新，不是定时送达保证。

没有设置 `PUBLISH_GIT_REMOTE` 时只本地导出，不推送远程。自动推送失败后至少等待 15 分钟再试。`.env`、GitHub 登录凭据、SSH 私钥都只留在后台机器上，不需要填写到 Pages 环境变量。

### 立即发布最新数据

**Windows 双击 `Publish.cmd` 即可立即发布**，窗口会保留，显示导出、推送进度与最终结果。它使用现有 `.env`，不会重新建仓库或更改 Pages 设置；首次部署未配置成功时会明确报错。

终端方式：

```powershell
node scripts/publish-site.mjs
```

或者使用 Windows 包装脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Publish.ps1
```

手动命令会重新导出快照，跳过自动发布的间隔与失败退避等待，提交需要发布的改动并推送；仍然遵守互斥锁、远程仓库检查和不强推规则。如果内容与已发布版本完全相同，不会生成新提交，因此也不一定触发新的云端构建。`changed: false` 只说明本次导出内容没变，不等于推送失败；查看最终错误、GitHub 提交和部署状态。

### 更新功能或样式

1. 更新完整项目中的源码，保留 `.env`、`data/` 和独立的 `site/.git`。不要把只读站点仓库拉取到后台目录覆盖源码。
2. 修改后先验证本机程序；更新前推荐下载一致性数据库备份。
3. 停止再启动后台，加载新的服务端代码；运行手动发布命令导出并推送新前端和数据。
4. 等云端构建成功，访问正式域名并刷新。只刷新浏览器不会触发采集、推送或云端重新部署。

### 查看状态、重试和回退

- 本机：`node scripts/service.mjs status`；数据管理中查看同步及“只读发布”事件。日志在实际 `DATA_DIR` 下的 `server.log`、`server-error.log`；私有发布状态是 `publication.json`。
- GitHub：检查发布仓库的最新提交、Actions 和 Settings → Pages。需要重新构建当前提交时，可运行 `gh api --method POST repos/your-name/broken-arrow-court-public/pages/builds`，再检查构建状态；这不是刷新按钮。
- Cloudflare：进入项目的 Deployments 查看提交号及日志。重试旧部署不等于发布最新提交，先确认目标提交正确；也可按[官方 Deploy Hooks 教程](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)触发指定分支部署。Hook URL 是秘密，不要公开或写进 README。
- 云端回退只影响展示版本，不会恢复本机数据库。数据恢复请按备份章节执行；修复本机后再发布新快照。不要使用强推来回退自动发布仓库。

保留最近两代本地静态资源；老页面遇到过期资源时需要重新加载。页面每分钟检测新版本并提示刷新。后台浏览器不必保持打开，但机器和服务需要保持运行、联网；休眠期间不会采集或上传。默认两小时合并用于减少部署次数，不等于承诺任何云平台的免费额度足够，实际额度以平台当前规则为准。

<a id="deployment-faq"></a>

## 常见部署问题

| 现象 | 排查与处理 |
| --- | --- |
| 手机打不开 `127.0.0.1` / `localhost` | 这会指向手机自身。公网只读版用 `github.io` / `pages.dev` 地址；同一 Wi-Fi 下访问后台需另外配置局域网监听 |
| 电脑能开，手机免代理打不开公网地址 | 换 Wi-Fi/移动数据对比，记录具体域名、报错和运营商。Pages 托管不保证大陆直连，自定义域名也不保证；不要反复改程序来处理网络超时 |
| 部署成功但页面一直加载 | 检查 `manifest.json`、`.sqlite.gz`、`.wasm`、`.mjs` 是否可下载以及浏览器是否支持 WebAssembly 和 gzip 解压 API；手机更新到现代浏览器；首次需下载索引，不只是 HTML |
| 首页 404 或只有空白 | 确认 `main` 已推送、发布目录是远程仓库根目录 `/`、根目录有 `index.html`、构建已成功；Cloudflare 确认创建的是 Pages |
| 图表显示 0 局 | 先在本机完成同步，确认三位不同朋友确实参战；默认普通模式、日期和同队筛选也可能排除记录 |
| `gh` / `git` / `node` 不是命令 | 安装对应工具并重新打开终端；应用需要 Node.js 24+ |
| 双击后没反应、打开编辑器或窗口闪退 | 使用 `Deploy-GitHubPages.cmd` / `Publish.cmd`，不要双击 `.ps1`。启动器保留窗口；查看进度、错误或是否正在等待输入。部署确认输入 `y` 后才能继续 |
| CLI 已登录但推送失败 | 检查 `gh auth status`、仓库写权限、网络与凭据；一键脚本只在生成仓库内接入 CLI 凭据，不修改全局 Git 设置 |
| 一键脚本拒绝私有仓库 | 属于安全限制，不会自动公开资料。使用新的公开空仓库，或在支持私有来源的 Pages 套餐中手动配置 |
| 输出目录非空、不受管文件、远程不匹配或已有暂存修改 | 不要删除数据库、强推或对项目根目录 `git add .`。先核对 `site/` 及其 origin，处理不相关修改；不确定时保留旧目录并选择新的独立输出目录 |
| `已有静态导出或提交任务正在运行` | 等正在执行的任务结束后重试。不要在任务运行时强删锁或移动 `site/` |
| 线上还是旧数据 | 对比本机导出版本、仓库最新提交、云端当前部署提交；三者不同就逐段检查。确认部署完成后重新加载页面 |

出错时不要贴出 `.env`、数据库、完整原始日志、Token、Cookie 或 Deploy Hook；提供脱敏后的错误信息、提交号、页面截图及公开网址即可。

## Windows 自动启动

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Autostart.ps1
```

在当前 Windows 用户的启动目录创建指向本工作区的快捷方式。登录 Windows 后后台启动，不弹出终端或浏览器。移除：`Uninstall-Autostart.ps1`。电脑关机、休眠或离线期间不能抓取；恢复运行后自动补查当前仍可获取的历史。需要全天候同步时，把程序部署到持续在线的机器。

## 配置与局域网

将 `.env.example` 复制为 `.env` 后修改。日常同步间隔和开关可以在界面调整。`DATA_DIR` 为相对工作目录或绝对路径。`SOURCE_BASE_URL` 可切换到站方授权提供的兼容数据源。`SOURCE_DETAIL_PATH` 仅在站方提供了兼容 JSON 详情端点时设置，默认从已验证的公开单场页面读取。

| 配置项 | 用途 |
| --- | --- |
| `HOST` / `PORT` | 后台监听地址与首选端口，默认 `127.0.0.1:4317` |
| `DATA_DIR` | 私有数据库、备份、日志和服务状态目录，默认 `./data` |
| `SOURCE_BASE_URL` | 授权的兼容采集源，默认 BAtrace |
| `STATIC_EXPORT_ENABLED` / `STATIC_OUTPUT_DIR` | 是否自动生成公开快照，以及独立输出目录 |
| `PUBLISH_GIT_REMOTE` / `PUBLISH_GIT_BRANCH` | 独立静态发布仓库及分支；未配置 remote 时不推送 |
| `PUBLISH_MIN_INTERVAL_MINUTES` | 自动推送最小间隔，默认 120 分钟，程序下限 5 分钟 |
| `PUBLIC_ORIGIN` / `SECURE_COOKIE` | 仅在后台本身放到 HTTPS 反向代理后时配置，不要填写 GitHub Pages 地址 |

默认只监听本机。朋友需要从其他电脑注册时，可以在 `.env` 设置 `HOST=0.0.0.0`，重启后用此电脑的局域网 IP 访问，且须允许 Windows 防火墙的对应端口。应用不自动修改防火墙或路由器。不要为静态只读展示开放电脑公网管理端口；确需公网管理后台时，应另外配置 HTTPS 反向代理、访问限制及相应 Cookie/Origin 设置。

登录使用 scrypt 密码哈希、HttpOnly/SameSite 会话 Cookie、CSRF 及来源检查、邀请注册、管理权限和登录限速。停用朋友或更新密码会撤销会话；管理员的配置、注册、归属调整和导入等操作有审计记录。

## 开发与验证

```sh
node --test --test-concurrency=1 test/*.test.mjs
node scripts/verify-source.mjs
```

自动化测试覆盖三人规则、多账号、双方参战、观战、重分类、分页及断点、限流、完整详情、去重、原子导入、备份一致性、注册、邀请、权限与会话撤销。`verify-source.mjs` 会用独立 `.cache` 数据库对公开玩家和比赛做少量真实读取，不向正式名单或数据库填充示例数据。

浏览器验证脚本 `scripts/check-ui.mjs` 需要 Playwright 和 Chrome/Chromium。可通过 `PLAYWRIGHT_MODULE` 指定已安装的 Playwright 模块绝对路径。应用本身不需要 Playwright。

只读导出测试：`node --test test/static.test.mjs`；独立静态浏览器验收：`node scripts/check-readonly-ui.mjs`。一键部署的安全分支与配置保留使用模拟 GitHub/Git 测试，不创建真实测试仓库；脚本帮助：`node scripts/deploy-github-pages.mjs --help`。

Lucide 图标使用 ISC 许可，见 `public/LUCIDE-LICENSE`。
