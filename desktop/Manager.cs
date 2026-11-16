using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace BrokenArrowCourtDesktop
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool testing = args.Length > 1 && args[0] == "--self-test";
            try
            {
                if (testing) { SelfTest.Run(Path.GetFullPath(args[1])); return 0; }
                string adjacent = AppDomain.CurrentDomain.BaseDirectory;
                string root = Bundle.IsProject(adjacent) ? adjacent : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BrokenArrowCourt", "application");
                if (args.Length == 2 && args[0] == "--project") root = Path.GetFullPath(args[1]);
                root = Path.GetFullPath(root);
                using (var instance = new ManagerInstance(root))
                {
                    if (!instance.IsPrimary)
                    {
                        if (!instance.ActivateExisting(5000)) MessageBox.Show("已有管理器正在启动或暂未响应。请稍候，或从系统托盘打开管理器；不会再创建重复窗口。", "断剑蘸饭审判法庭", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        return 0;
                    }
                    using (var form = new ManagerForm(root, false))
                    {
                        instance.Listen(form);
                        Application.Run(form);
                    }
                }
                return 0;
            }
            catch (Exception e)
            {
                if (testing) { Directory.CreateDirectory(args[1]); File.WriteAllText(Path.Combine(args[1], "failure.txt"), e.ToString()); }
                else MessageBox.Show(e.Message, "断剑蘸饭审判法庭", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }

    sealed class ManagerInstance : IDisposable
    {
        readonly Mutex mutex;
        readonly EventWaitHandle activate, acknowledged;
        RegisteredWaitHandle listener;
        internal readonly bool IsPrimary;
        [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);

        internal ManagerInstance(string root)
        {
            string scope = Environment.UserDomainName + "\\" + Environment.UserName + "|" + Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant();
            string key;
            using (var bytes = new MemoryStream(Encoding.UTF8.GetBytes(scope))) key = "Local\\BrokenArrowCourt.Manager." + Bundle.Hash(bytes);
            mutex = new Mutex(true, key, out IsPrimary);
            activate = new EventWaitHandle(false, EventResetMode.AutoReset, key + ".activate");
            acknowledged = new EventWaitHandle(false, EventResetMode.AutoReset, key + ".ack");
        }
        internal void Listen(ManagerForm form)
        {
            if (!IsPrimary) throw new InvalidOperationException("Only the primary manager can listen");
            var handle = form.Handle;
            listener = ThreadPool.RegisterWaitForSingleObject(activate, (s, expired) => {
                try { form.BeginInvoke(new Action(() => { if (!form.IsDisposed) { form.ShowManager(); acknowledged.Set(); } })); }
                catch (InvalidOperationException) { }
            }, null, Timeout.Infinite, false);
        }
        internal bool ActivateExisting(int timeout)
        {
            // The new foreground process may grant focus only to this same executable.
            string executable = Assembly.GetExecutingAssembly().Location;
            foreach (var process in Process.GetProcessesByName(Process.GetCurrentProcess().ProcessName))
            using (process) try { if (process.Id != Process.GetCurrentProcess().Id && string.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) AllowSetForegroundWindow(process.Id); } catch { }
            acknowledged.Reset(); activate.Set(); return acknowledged.WaitOne(timeout);
        }
        public void Dispose()
        {
            if (listener != null) listener.Unregister(null);
            activate.Dispose(); acknowledged.Dispose();
            if (IsPrimary) mutex.ReleaseMutex(); mutex.Dispose();
        }
    }

    static class Bundle
    {
        internal static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        internal static bool IsProject(string root) { return File.Exists(Path.Combine(root, "src", "server.mjs")) && File.Exists(Path.Combine(root, "scripts", "desktop-control.mjs")); }
        internal static string Node(string root) { return Path.Combine(root, ".desktop", "runtime", "node.exe"); }
        internal static string Hash(Stream stream) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
        internal static bool Allowed(string name)
        {
            if (name.Contains("\\") || name.StartsWith("/") || name.Split('/').Any(p => p == ".." || p == "." || p.Length == 0)) return false;
            if (name == "__runtime/node.exe" || name == "__runtime/NODE-LICENSE.txt") return true;
            string[] folders = { "src/", "scripts/", "public/", "readonly/", "vendor/", "test/", "desktop/" };
            string[] files = { "README.md", "package.json", ".env.example", ".gitignore", "Start.ps1", "Stop.ps1", "Install-Autostart.ps1", "Uninstall-Autostart.ps1", "Deploy-GitHubPages.ps1", "Deploy-GitHubPages.cmd", "Publish.ps1", "Publish.cmd" };
            return folders.Any(name.StartsWith) || files.Contains(name);
        }
        internal static string Target(string root, string name)
        {
            if (!Allowed(name)) throw new InvalidDataException("包内存在不允许的路径：" + name);
            string relative = name.StartsWith("__runtime/") ? ".desktop/runtime/" + name.Substring(10) : name;
            string prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string target = Path.GetFullPath(Path.Combine(prefix, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("无效的解包路径");
            return target;
        }
        static void RejectLinks(string root, string target)
        {
            string p = target, boundary = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            while (p.Length >= boundary.Length)
            {
                if ((File.Exists(p) || Directory.Exists(p)) && (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0) throw new IOException("不向符号链接或目录联接解包：" + p);
                if (string.Equals(p.TrimEnd(Path.DirectorySeparatorChar), boundary, StringComparison.OrdinalIgnoreCase)) break;
                p = Path.GetDirectoryName(p);
            }
        }
        internal static void Prepare(string root, Action<string> progress)
        {
            bool existing = IsProject(root);
            if (!existing && Directory.Exists(root) && Directory.GetFileSystemEntries(root).Any(p => Path.GetFileName(p) != ".desktop")) throw new IOException("所选目录非空且不是完整项目。请选择原项目，或选择新的空目录。");
            Directory.CreateDirectory(root);
            using (var manifestStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("court.manifest"))
            using (var reader = new StreamReader(manifestStream))
            using (var zipStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("court.bundle"))
            using (var zip = new ZipArchive(zipStream, ZipArchiveMode.Read))
            {
                var manifest = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                var entries = ((IEnumerable)manifest["files"]).Cast<Dictionary<string, object>>().ToDictionary(x => (string)x["path"]);
                if (zip.Entries.Count != entries.Count) throw new InvalidDataException("程序包清单不一致");
                foreach (var entry in zip.Entries)
                {
                    if (!entries.ContainsKey(entry.FullName) || !Allowed(entry.FullName)) throw new InvalidDataException("程序包包含未登记文件");
                    if (existing && !entry.FullName.StartsWith("__runtime/")) continue;
                    string target = Target(root, entry.FullName), expected = (string)entries[entry.FullName]["sha256"];
                    RejectLinks(root, target);
                    if (File.Exists(target)) using (var f = File.OpenRead(target)) { if (Hash(f) == expected) continue; }
                    progress("正在准备 " + entry.FullName);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    string temp = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
                    try
                    {
                        using (var source = entry.Open()) using (var dest = File.Create(temp)) source.CopyTo(dest);
                        using (var f = File.OpenRead(temp)) if (Hash(f) != expected) throw new InvalidDataException("程序包校验失败：" + entry.FullName);
                        if (File.Exists(target)) File.Replace(temp, target, null); else File.Move(temp, target);
                    }
                    finally { if (File.Exists(temp)) File.Delete(temp); }
                }
            }
            if (!IsProject(root)) throw new IOException("程序文件准备失败");
        }
    }

    sealed class RunResult { internal int Code; internal string Output; internal string Error; }
    static class Runner
    {
        internal static string Quote(string value)
        {
            var b = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); }
                else { b.Append('\\', slashes); b.Append(c); }
                slashes = 0;
            }
            b.Append('\\', slashes * 2); return b.Append('"').ToString();
        }
        internal static string Tool(string name)
        {
            var known = new List<string>();
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (name == "git.exe") known.Add(Path.Combine(pf, "Git", "cmd", name));
            if (name == "gh.exe") known.Add(Path.Combine(pf, "GitHub CLI", name));
            foreach (string dir in EnvironmentPath().Split(';')) if (!string.IsNullOrWhiteSpace(dir)) known.Add(Path.Combine(dir.Trim('"'), name));
            return known.FirstOrDefault(File.Exists);
        }
        internal static string EnvironmentPath()
        {
            return string.Join(";", new[] { Environment.GetEnvironmentVariable("PATH") ?? "", Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine) ?? "", Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "GitHub CLI") });
        }
        internal static RunResult Run(string exe, IEnumerable<string> args, string root, Action<string> log)
        {
            var start = new ProcessStartInfo(exe, string.Join(" ", args.Select(Quote))) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            start.EnvironmentVariables["PATH"] = EnvironmentPath(); start.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0"; start.EnvironmentVariables["GH_PROMPT_DISABLED"] = "1"; start.EnvironmentVariables["NODE_NO_WARNINGS"] = "1";
            var output = new StringBuilder(); var error = new StringBuilder();
            using (var process = new Process { StartInfo = start })
            {
                process.OutputDataReceived += (s, e) => { if (e.Data != null) { output.AppendLine(e.Data); if (log != null) log(e.Data); } };
                process.ErrorDataReceived += (s, e) => { if (e.Data != null) { error.AppendLine(e.Data); if (log != null) log(e.Data); } };
                process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
                if (!process.WaitForExit(15 * 60 * 1000)) { process.Kill(); throw new TimeoutException("操作超时。请查看日志及发布仓库状态后再重试。"); }
                process.WaitForExit(); return new RunResult { Code = process.ExitCode, Output = output.ToString().Trim(), Error = error.ToString().Trim() };
            }
        }
    }

    sealed class ManagerForm : Form
    {
        string root; bool busy, refreshing, ready, testing, exitRequested, pendingFailure, trayTransition;
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
        NotifyIcon tray;
        ContextMenuStrip trayMenu;
        ToolStripMenuItem trayStart, trayStop, trayExit;
        FormWindowState restoreState = FormWindowState.Normal;
        TextBox projectBox, repositoryBox, logBox;
        Label serviceLabel, archiveLabel, publicationLabel, toolsLabel, currentLabel, trafficLabel, scheduleLabel;
        CheckBox consentBox, createBox, restartBox, autoSyncBox;
        DataGridView requestHistory;
        DataGridView storageHistory;
        Label statisticsLabel, storageLabel;
        DateTimePicker statisticsFrom, statisticsTo;
        ComboBox statisticsGroup, statisticsSource, sourceChoice;
        int statisticsPage = 1, statisticsPages = 1;
        string queryFrom = "", queryTo = "", queryGroup = "day", queryProvider = "all";
        bool sourceDirty, applyingSource;
        NumericUpDown interval;
        ProgressBar progress;
        readonly List<Button> operations = new List<Button>();
        Dictionary<string, object> state = new Dictionary<string, object>();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 30000 };

        internal ManagerForm(string project, bool test)
        {
            root = project; testing = test; Text = "断剑蘸饭审判法庭 - 桌面管理器";
            AutoScaleMode = AutoScaleMode.None;
            Size = new Size(1120, 840); MinimumSize = new Size(880, 640); StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F); BackColor = Color.FromArgb(246, 248, 247);
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(18, 12, 18, 10), ColumnCount = 1, RowCount = 4 };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(layout);
            layout.Controls.Add(new Label { Text = "断剑蘸饭审判法庭", Font = new Font(Font.FontFamily, 16F, FontStyle.Bold), AutoSize = true, ForeColor = Color.FromArgb(35, 67, 54), Margin = new Padding(0, 0, 0, 12) }, 0, 0);
            var projectRow = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 4, Margin = new Padding(0, 0, 0, 12) };
            projectRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); projectRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            projectRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); projectRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            projectRow.Controls.Add(new Label { Text = "项目目录", AutoSize = true, Margin = new Padding(0, 8, 10, 0) }, 0, 0);
            projectBox = new TextBox { ReadOnly = true, Dock = DockStyle.Fill, Text = root, Margin = new Padding(0, 4, 8, 0) }; projectRow.Controls.Add(projectBox, 1, 0);
            projectRow.Controls.Add(Button("选择目录", SelectProject), 2, 0); projectRow.Controls.Add(Button("打开目录", () => OpenFolder(root), false), 3, 0); layout.Controls.Add(projectRow, 0, 1);
            var tabs = new TabControl { Dock = DockStyle.Fill, Margin = Padding.Empty };
            var home = new TabPage("后台与状态") { AutoScroll = true, BackColor = Color.White, Padding = new Padding(14) };
            var publishing = new TabPage("网页发布") { AutoScroll = true, BackColor = Color.White, Padding = new Padding(14) };
            var logs = new TabPage("运行日志") { BackColor = Color.White, Padding = new Padding(10) };
            var traffic = new TabPage("请求统计") { BackColor = Color.White, Padding = new Padding(14) };
            var storage = new TabPage("本地空间") { BackColor = Color.White, Padding = new Padding(14) };
            tabs.TabPages.AddRange(new[] { home, publishing, logs, traffic, storage }); layout.Controls.Add(tabs, 0, 2);
            var homeLayout = Stack(home); var publishLayout = Stack(publishing);
            serviceLabel = Status("后台：待检查", 0); archiveLabel = Status("朋友 / 对局：待检查", 0); publicationLabel = Status("最后推送：待检查", 0);
            homeLayout.Controls.Add(serviceLabel); homeLayout.Controls.Add(archiveLabel); homeLayout.Controls.Add(publicationLabel);
            trafficLabel = Status("今日请求 / 接收正文：待检查", 0); homeLayout.Controls.Add(trafficLabel);
            var syncRow = Row();
            autoSyncBox = new CheckBox { Text = "开启自动同步", AutoSize = true, Enabled = false, Margin = new Padding(0, 7, 16, 0) };
            autoSyncBox.Click += async (s, e) => await ToggleAutoSync(); syncRow.Controls.Add(autoSyncBox);
            syncRow.Controls.Add(Button("查看每日请求统计", () => SelectTab(3), false)); homeLayout.Controls.Add(syncRow);
            scheduleLabel = Status("自动检查时间：待检查", 0); homeLayout.Controls.Add(scheduleLabel);
            var sourceRow = Row(); sourceRow.Controls.Add(new Label { Text = "采集数据源", AutoSize = true, Margin = new Padding(0, 8, 8, 0) });
            sourceChoice = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 300 }; sourceChoice.Items.AddRange(new object[] { "BATrace", "官方上游（直连）" }); sourceChoice.SelectedIndex = 0;
            sourceChoice.SelectedIndexChanged += (s, e) => { if (!applyingSource) sourceDirty = true; }; sourceRow.Controls.Add(sourceChoice);
            sourceRow.Controls.Add(Button("切换数据源", async () => await ChangeSource()));
            sourceRow.Controls.Add(Button("查看本地空间", async () => { SelectTab(4); await ScanStorage(); }, false)); homeLayout.Controls.Add(sourceRow);
            homeLayout.Controls.Add(Status("官方源不回退到 BATrace；沿用本地单位目录，缺少的比赛模式保留未知。", 0));
            var trafficLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
            trafficLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); trafficLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); trafficLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); traffic.Controls.Add(trafficLayout);
            var queryRow = Row();
            statisticsFrom = new DateTimePicker { Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy-MM-dd", ShowCheckBox = true, Checked = false, Font = new Font(Font.FontFamily, 8F), Width = 245, Value = DateTime.UtcNow.AddHours(8).Date };
            statisticsTo = new DateTimePicker { Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy-MM-dd", ShowCheckBox = true, Checked = false, Font = new Font(Font.FontFamily, 8F), Width = 245, Value = DateTime.UtcNow.AddHours(8).Date };
            statisticsFrom.Checked = statisticsTo.Checked = false;
            statisticsGroup = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 120, Font = new Font(Font.FontFamily, 8F) }; statisticsGroup.Items.AddRange(new object[] { "按日", "按月", "按年" }); statisticsGroup.SelectedIndex = 0;
            statisticsSource = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 180, Font = new Font(Font.FontFamily, 8F) }; statisticsSource.Items.AddRange(new object[] { "所有来源", "BATrace", "官方上游" }); statisticsSource.SelectedIndex = 0;
            queryRow.Controls.Add(new Label { Text = "起止日期（不勾选即全部）", AutoSize = true }); queryRow.Controls.Add(statisticsFrom); queryRow.Controls.Add(statisticsTo); queryRow.Controls.Add(statisticsGroup); queryRow.Controls.Add(statisticsSource);
            queryRow.Controls.Add(Button("查询", async () => await QueryStatistics(1, true))); queryRow.Controls.Add(Button("上一页", async () => await QueryStatistics(Math.Max(1, statisticsPage - 1), false))); queryRow.Controls.Add(Button("下一页", async () => await QueryStatistics(Math.Min(statisticsPages, statisticsPage + 1), false)));
            trafficLayout.Controls.Add(queryRow, 0, 0);
            var trafficHint = new Label { Text = "北京时间自然日 · 旧日志与补证是可核实下限，历史数据量未知。\n来源列依次为：逐次记录 / 旧日志 / 补证。正文为解压后大小；历史日按同步任务开始日期归属。", Font = new Font(Font.FontFamily, 8F), AutoSize = true, Dock = DockStyle.Fill, MaximumSize = new Size(980, 0), Margin = new Padding(0, 0, 0, 12) };
            statisticsLabel = trafficHint; trafficLayout.Controls.Add(trafficHint, 0, 1);
            traffic.SizeChanged += (s, e) => trafficHint.MaximumSize = new Size(Math.Max(250, traffic.ClientSize.Width - 35), 0);
            requestHistory = new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, RowHeadersVisible = false, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize, AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells, Font = new Font(Font.FontFamily, 8F), BackgroundColor = Color.White, BorderStyle = BorderStyle.None, SelectionMode = DataGridViewSelectionMode.FullRowSelect };
            requestHistory.Columns.Add("date", "日期"); requestHistory.Columns.Add("requests", "请求数"); requestHistory.Columns.Add("origin", "逐次 / 旧日志 / 补证"); requestHistory.Columns.Add("bytes", "接收正文"); requestHistory.Columns.Add("runs", "全站轮数");
            requestHistory.Columns[0].MinimumWidth = 180; requestHistory.Columns[0].AutoSizeMode = DataGridViewAutoSizeColumnMode.None; requestHistory.Columns[0].Width = 180;
            requestHistory.Columns[2].MinimumWidth = 200;
            requestHistory.DefaultCellStyle.Padding = new Padding(4, 3, 4, 3);
            trafficLayout.Controls.Add(requestHistory, 0, 2);
            var storageLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 }; storageLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); storageLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); storageLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); storage.Controls.Add(storageLayout);
            var storageActions = Row(); storageActions.Controls.Add(Button("计算空间占用", async () => await ScanStorage())); storageLayout.Controls.Add(storageActions, 0, 0);
            storageLabel = new Label { Text = "点击计算，查看项目、数据库、备份、缓存及磁盘可用空间。", AutoSize = true, Dock = DockStyle.Fill, MaximumSize = new Size(900, 0), Margin = new Padding(0, 6, 0, 12) }; storageLayout.Controls.Add(storageLabel, 0, 1);
            storage.SizeChanged += (s, e) => storageLabel.MaximumSize = new Size(Math.Max(250, storage.ClientSize.Width - 35), 0);
            storageHistory = new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, RowHeadersVisible = false, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize, AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells, Font = new Font(Font.FontFamily, 8F), BackgroundColor = Color.White };
            storageHistory.Columns.Add("name", "目录 / 文件"); storageHistory.Columns.Add("size", "大小"); storageHistory.Columns.Add("files", "文件数"); storageLayout.Controls.Add(storageHistory, 0, 2);
            var serviceRow = Row(); serviceRow.Controls.Add(Button("启动后台", async () => await Operation("启动后台", async () => await Node("scripts/service.mjs", "start"))));
            serviceRow.Controls.Add(Button("停止后台", async () => await Operation("停止后台", async () => await Node("scripts/service.mjs", "stop"))));
            serviceRow.Controls.Add(Button("重启后台", async () => await Operation("重启后台", Restart)));
            serviceRow.Controls.Add(Button("打开本机管理页", () => OpenUrl(Value("local_url", "http://127.0.0.1:4317")), false));
            serviceRow.Controls.Add(Button("打开只读预览", () => OpenUrl(Value("local_url", "http://127.0.0.1:4317") + "/readonly/"), false)); homeLayout.Controls.Add(serviceRow);
            var courtRow = Row();
            courtRow.Controls.Add(Button("开启开庭模式", async () => await Operation("开庭", async () => await Node("scripts/court-mode.mjs", "on"))));
            courtRow.Controls.Add(Button("恢复常规界面", async () => await Operation("休庭", async () => await Node("scripts/court-mode.mjs", "off")))); homeLayout.Controls.Add(courtRow);
            toolsLabel = new Label { Text = "环境：待检查", AutoSize = true, Margin = new Padding(0, 12, 0, 10) }; homeLayout.Controls.Add(toolsLabel);
            var checks = Row(); checks.Controls.Add(Button("检查环境与部署", async () => await Operation("检查环境与部署", async () => await Refresh(true))));
            checks.Controls.Add(Button("登录 GitHub", Login)); checks.Controls.Add(Button("打开线上网页", () => { if (Value("public_url", "") == "") throw new Exception("尚未配置发布仓库"); OpenUrl(Value("public_url", "")); }, false)); homeLayout.Controls.Add(checks);
            var links = Row(); links.Controls.Add(Link("部署教程", () => OpenFile(Path.Combine(root, "README.md")))); links.Controls.Add(Link("Git 下载", () => OpenUrl("https://git-scm.com/downloads/win")));
            links.Controls.Add(Link("GitHub CLI 下载", () => OpenUrl("https://cli.github.com/"))); links.Controls.Add(Link("Cloudflare 控制台", () => OpenUrl("https://dash.cloudflare.com/"))); homeLayout.Controls.Add(links);
            publishLayout.Controls.Add(new Label { Text = "GitHub 仓库（用户名 / 仓库）", AutoSize = true, Margin = new Padding(0, 0, 0, 8) });
            repositoryBox = new TextBox { Dock = DockStyle.Top, Margin = new Padding(0, 0, 0, 12) }; publishLayout.Controls.Add(repositoryBox);
            createBox = new CheckBox { Text = "不存在时创建公开仓库", AutoSize = true, Margin = new Padding(0, 0, 0, 10) }; publishLayout.Controls.Add(createBox);
            var optionRow = Row(); optionRow.Controls.Add(new Label { Text = "其他更改推送间隔（分钟）", AutoSize = true, Margin = new Padding(0, 8, 10, 0) });
            interval = new NumericUpDown { Minimum = 5, Maximum = 10080, Value = 120, Width = 95, Margin = new Padding(0, 4, 10, 0) }; optionRow.Controls.Add(interval);
            optionRow.Controls.Add(Button("保存间隔", async () => await Operation("保存发布间隔", async () => { await Node("scripts/desktop-control.mjs", "interval", "--minutes", interval.Value.ToString()); Append("间隔已保存；重启后台后生效。"); })));
            publishLayout.Controls.Add(optionRow);
            restartBox = new CheckBox { Text = "部署成功后重启后台", AutoSize = true, Checked = true, Margin = new Padding(0, 8, 0, 12) }; publishLayout.Controls.Add(restartBox);
            consentBox = new CheckBox { Text = "首次部署：同意公开称呼、账号关联、对局与单位明细", AutoSize = true, Margin = new Padding(0, 0, 0, 14) }; publishLayout.Controls.Add(consentBox);
            var publishRow = Row();
            var deploy = Button("一键部署 Pages", Deploy); Accent(deploy); publishRow.Controls.Add(deploy);
            var publish = Button("立即更新网页", Publish); Accent(publish); publishRow.Controls.Add(publish);
            publishRow.Controls.Add(Button("仅导出只读版", async () => await Operation("导出只读版", async () => await Node("scripts/export-site.mjs"))));
            publishLayout.Controls.Add(publishRow);
            var logLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 }; logLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); logLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); logs.Controls.Add(logLayout);
            logBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Fill, Font = new Font("Consolas", 9F), BackColor = Color.White, BorderStyle = BorderStyle.FixedSingle }; logLayout.Controls.Add(logBox, 0, 0);
            var logActions = Row(); logActions.Controls.Add(Link("复制日志", () => Clipboard.SetText(logBox.Text.Length == 0 ? "无日志" : logBox.Text))); logActions.Controls.Add(Link("清空显示", () => logBox.Clear())); logLayout.Controls.Add(logActions, 0, 1);
            var footer = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2, Margin = new Padding(0, 8, 0, 0) }; footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
            currentLabel = new Label { Text = "准备中", Dock = DockStyle.Fill, AutoEllipsis = true, MinimumSize = new Size(0, Font.Height + 6) }; progress = new ProgressBar { Dock = DockStyle.Fill, Visible = false, Style = ProgressBarStyle.Marquee }; footer.Controls.Add(currentLabel, 0, 0); footer.Controls.Add(progress, 1, 0); layout.Controls.Add(footer, 0, 3);
            publishing.SizeChanged += (s, e) => consentBox.MaximumSize = new Size(Math.Max(250, publishing.ClientSize.Width - 50), 0);
            home.SizeChanged += (s, e) => { toolsLabel.MaximumSize = new Size(Math.Max(250, home.ClientSize.Width - 50), 0); publicationLabel.MaximumSize = toolsLabel.MaximumSize; trafficLabel.MaximumSize = toolsLabel.MaximumSize; scheduleLabel.MaximumSize = toolsLabel.MaximumSize; };
            InitializeTray();
            Resize += (s, e) => {
                if (trayTransition) return;
                if (WindowState == FormWindowState.Minimized) HideToTray();
                else if (Visible) restoreState = WindowState;
            };
            timer.Tick += async (s, e) => { if (!busy && ready) try { await Refresh(false); } catch (Exception error) { currentLabel.Text = error.Message; } };
            if (!testing) Shown += async (s, e) => await Initialize();
        }
        void InitializeTray()
        {
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("显示管理器", null, (s, e) => ShowManager());
            trayMenu.Items.Add("打开本机管理页", null, (s, e) => { try { OpenUrl(Value("local_url", "http://127.0.0.1:4317")); } catch (Exception error) { Failure(error); } });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayStart = new ToolStripMenuItem("启动后台", null, async (s, e) => await Operation("启动后台", async () => await Node("scripts/service.mjs", "start")));
            trayStop = new ToolStripMenuItem("停止后台", null, async (s, e) => await Operation("停止后台", async () => await Node("scripts/service.mjs", "stop")));
            trayMenu.Items.Add(trayStart); trayMenu.Items.Add(trayStop);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayExit = new ToolStripMenuItem("退出管理器（后台继续运行）", null, (s, e) => ExitManager()); trayMenu.Items.Add(trayExit);
            tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "蘸饭法庭 · 桌面管理器", ContextMenuStrip = trayMenu, Visible = !testing };
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowManager(); };
            tray.MouseDoubleClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowManager(); };
        }
        internal void HideToTray()
        {
            if (IsDisposed || trayTransition) return;
            trayTransition = true;
            try
            {
                if (Visible && WindowState != FormWindowState.Minimized) restoreState = WindowState;
                // Hide already removes the taskbar button. Changing ShowInTaskbar here
                // recreates the HWND and can re-enter Resize while Windows minimizes it.
                tray.Visible = true; Hide();
            }
            finally { trayTransition = false; }
        }
        internal void ShowManager()
        {
            if (IsDisposed || trayTransition) return;
            trayTransition = true;
            try
            {
                var targetState = restoreState == FormWindowState.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
                Show();
                // Restore the native window after Show: the managed state alone can
                // disagree with Windows after a minimize notification or handle recreation.
                if (WindowState == FormWindowState.Minimized || IsIconic(Handle)) ShowWindow(Handle, 9); // SW_RESTORE
                WindowState = targetState;
                var bounds = targetState == FormWindowState.Normal ? Bounds : RestoreBounds;
                if (!Screen.AllScreens.Any(screen => Rectangle.Intersect(screen.WorkingArea, new Rectangle(bounds.X, bounds.Y, bounds.Width, Math.Min(40, bounds.Height))).Width >= 100))
                {
                    var area = Screen.FromPoint(Cursor.Position).WorkingArea;
                    WindowState = FormWindowState.Normal;
                    Size = new Size(Math.Min(Width, area.Width), Math.Min(Height, area.Height));
                    Location = new Point(area.Left + Math.Max(0, (area.Width - Width) / 2), area.Top + Math.Max(0, (area.Height - Height) / 2));
                    WindowState = targetState;
                }
                restoreState = targetState;
                BringToFront(); Activate(); SetForegroundWindow(Handle);
            }
            finally { trayTransition = false; }
            if (pendingFailure) { SelectTab(2); pendingFailure = false; tray.Text = "蘸饭法庭 · 桌面管理器"; }
        }
        internal void ExitManager()
        {
            if (busy)
            {
                ShowManager();
                if (!testing) MessageBox.Show(this, "操作仍在执行，完成后可退出管理器。", Text);
                return;
            }
            exitRequested = true; Close();
        }
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (e.CloseReason == CloseReason.UserClosing && !exitRequested) { e.Cancel = true; HideToTray(); }
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                timer.Stop(); timer.Dispose();
                if (tray != null) { tray.Visible = false; tray.Dispose(); }
                if (trayMenu != null) trayMenu.Dispose();
            }
            base.Dispose(disposing);
        }
        internal bool IsInTray { get { return tray.Visible && !Visible; } }
        TableLayoutPanel Stack(TabPage page)
        {
            var stack = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, Margin = Padding.Empty };
            stack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); page.Controls.Add(stack); return stack;
        }
        FlowLayoutPanel Row() { return new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true, Margin = new Padding(0, 3, 0, 8) }; }
        Label Status(string text, int width) { return new Label { Text = text, AutoSize = true, Margin = new Padding(0, 5, 0, 10) }; }
        Button Button(string text, Action action, bool operation = true)
        {
            var b = new Button { Text = text, AutoSize = true, Height = 31, MinimumSize = new Size(96, 31), Margin = new Padding(0, 2, 8, 0), Padding = new Padding(5, 0, 5, 0) };
            b.Click += (s, e) => { try { action(); } catch (Exception error) { Failure(error); } };
            if (operation) operations.Add(b); return b;
        }
        LinkLabel Link(string text, Action action)
        {
            var l = new LinkLabel { Text = text, AutoSize = true, Margin = new Padding(0, 6, 18, 0), LinkColor = Color.FromArgb(43, 80, 115) };
            l.LinkClicked += (s, e) => { try { action(); } catch (Exception error) { Failure(error); } }; return l;
        }
        void Accent(Button b) { b.BackColor = Color.FromArgb(39, 91, 73); b.ForeColor = Color.White; b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0; }
        internal void SetBusy(bool value)
        {
            busy = value; foreach (var b in operations) b.Enabled = !value;
            trayStart.Enabled = trayStop.Enabled = trayExit.Enabled = !value;
            repositoryBox.Enabled = createBox.Enabled = consentBox.Enabled = restartBox.Enabled = interval.Enabled = !value;
            autoSyncBox.Enabled = !value && ready && state.ContainsKey("sync_enabled") && state["sync_enabled"] != null;
            sourceChoice.Enabled = statisticsFrom.Enabled = statisticsTo.Enabled = statisticsGroup.Enabled = statisticsSource.Enabled = !value;
            progress.Visible = value;
        }
        async Task Initialize()
        {
            SetBusy(true);
            try
            {
                await Task.Run(() => Bundle.Prepare(root, Append)); ready = true; Append("程序已准备就绪。项目目录：" + root);
                await Refresh(false); toolsLabel.Text = "Git：" + (Runner.Tool("git.exe") == null ? "未找到" : "已找到") + "    GitHub CLI：" + (Runner.Tool("gh.exe") == null ? "未找到" : "已找到") + "    登录状态：未检查";
                timer.Start(); currentLabel.Text = "就绪";
            }
            catch (Exception e) { Failure(e); }
            finally { SetBusy(false); }
        }
        internal void Append(string text)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke(new Action<string>(Append), text); } catch (InvalidOperationException) { } return; }
            text = Regex.Replace(text, @"(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+", "[REDACTED]");
            string line = DateTime.Now.ToString("HH:mm:ss") + "  " + text + Environment.NewLine;
            if (logBox.TextLength > 500000) logBox.Text = logBox.Text.Substring(logBox.TextLength / 2);
            logBox.AppendText(line); currentLabel.Text = text;
            try { string dir = Path.Combine(root, ".desktop"); Directory.CreateDirectory(dir); File.AppendAllText(Path.Combine(dir, "manager.log"), line, Encoding.UTF8); } catch { }
        }
        internal void Failure(Exception e)
        {
            Append("失败：" + e.Message); currentLabel.Text = "操作失败，详见日志";
            string summary = ErrorSummary(e.Message);
            if (!Visible || IsInTray)
            {
                pendingFailure = true; tray.Text = "蘸饭法庭 · 操作失败，请查看运行日志";
                if (!testing) tray.ShowBalloonTip(8000, "法庭操作未完成", summary.Length > 180 ? summary.Substring(0, 180) : summary, ToolTipIcon.Warning);
                return;
            }
            if (!testing) MessageBox.Show(this, summary, "操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        internal static string ErrorSummary(string message)
        {
            string text = string.Join(Environment.NewLine, message.Replace("\r\n", "\n").Split('\n').Take(6));
            if (text.Length > 500) text = text.Substring(0, 500);
            return text + Environment.NewLine + Environment.NewLine + "完整错误已记录在“运行日志”中。";
        }
        async Task Operation(string name, Func<Task> action)
        {
            if (busy) return; if (!ready) { Failure(new Exception("程序尚未准备完成，请先检查项目目录。")); return; }
            SetBusy(true); SelectTab(2); Append("开始：" + name);
            try { await action(); Append("完成：" + name); await Refresh(false); }
            catch (Exception e) { Failure(e); }
            finally { SetBusy(false); }
        }
        internal async Task<RunResult> Node(params string[] args)
        {
            var r = await Task.Run(() => Runner.Run(Bundle.Node(root), args, root, Append));
            if (r.Code != 0) throw new Exception("命令退出码 " + r.Code + "：" + (r.Error.Length > 0 ? r.Error : r.Output)); return r;
        }
        async Task Restart()
        {
            var stopped = await Node("scripts/service.mjs", "stop");
            if (stopped.Output.Contains("finishing the current source request")) throw new Exception("后台仍在等待当前采集请求结束，请稍后再启动。");
            await Node("scripts/service.mjs", "start");
        }
        async Task Refresh(bool tools)
        {
            if (refreshing) return; refreshing = true;
            try
            {
                var args = new List<string> { "scripts/desktop-control.mjs", "status" }; if (tools) args.Add("--tools");
                AddStatisticsArgs(args);
                var r = await Task.Run(() => Runner.Run(Bundle.Node(root), args, root, null));
                if (r.Code != 0) throw new Exception(r.Error); Apply(Bundle.Json.Deserialize<Dictionary<string, object>>(r.Output));
                if (tools) Append("环境与部署状态检查完成。");
            }
            finally { refreshing = false; }
        }
        string Value(string key, string fallback) { return state.ContainsKey(key) && state[key] != null ? state[key].ToString() : fallback; }
        string DateValue(string key) { DateTime date; return DateTime.TryParse(Value(key, ""), out date) ? date.ToLocalTime().ToString("MM-dd HH:mm:ss") : "未发布"; }
        static string Bytes(object value)
        {
            double n = Convert.ToDouble(value ?? 0); string[] units = { "B", "KiB", "MiB", "GiB" }; int unit = 0;
            while (n >= 1024 && unit < units.Length - 1) { n /= 1024; unit++; }
            return n.ToString(unit == 0 ? "N0" : "N2") + " " + units[unit];
        }
        void AddStatisticsArgs(List<string> args)
        {
            if (queryFrom != "") { args.Add("--from"); args.Add(queryFrom); } if (queryTo != "") { args.Add("--to"); args.Add(queryTo); }
            args.Add("--group"); args.Add(queryGroup); args.Add("--provider"); args.Add(queryProvider); args.Add("--page"); args.Add(statisticsPage.ToString());
        }
        async Task QueryStatistics(int page, bool readFilters)
        {
            if (busy || !ready) return;
            if (readFilters) { queryFrom = statisticsFrom.Checked ? statisticsFrom.Value.ToString("yyyy-MM-dd") : ""; queryTo = statisticsTo.Checked ? statisticsTo.Value.ToString("yyyy-MM-dd") : ""; queryGroup = new[] { "day", "month", "year" }[statisticsGroup.SelectedIndex]; queryProvider = new[] { "all", "batrace", "official" }[statisticsSource.SelectedIndex]; }
            statisticsPage = page; SetBusy(true);
            try { await Refresh(false); currentLabel.Text = "统计查询完成"; } catch (Exception error) { Failure(error); } finally { SetBusy(false); }
        }
        async Task ChangeSource()
        {
            if (busy || !ready) return; SetBusy(true);
            try { await Node("scripts/desktop-control.mjs", "source", sourceChoice.SelectedIndex == 1 ? "official" : "batrace"); sourceDirty = false; await Refresh(false); currentLabel.Text = "数据源已切换；自动同步开关保持原状态"; }
            catch (Exception error) { Failure(error); } finally { SetBusy(false); }
        }
        async Task ScanStorage()
        {
            if (busy || !ready) return; SetBusy(true);
            try { var args = new List<string> { "scripts/desktop-control.mjs", "status", "--storage" }; AddStatisticsArgs(args); var result = await Task.Run(() => Runner.Run(Bundle.Node(root), args, root, null)); if (result.Code != 0) throw new Exception(result.Error); Apply(Bundle.Json.Deserialize<Dictionary<string, object>>(result.Output)); currentLabel.Text = "空间占用已更新"; }
            catch (Exception error) { Failure(error); } finally { SetBusy(false); }
        }
        async Task ToggleAutoSync()
        {
            if (busy || !ready) return;
            bool enabled = autoSyncBox.Checked; SetBusy(true);
            try { await Node("scripts/desktop-control.mjs", "sync", enabled ? "on" : "off"); await Refresh(false); currentLabel.Text = enabled ? "自动同步已开启，按时间表检查" : "自动同步已关闭"; }
            catch (Exception error) { autoSyncBox.Checked = Value("sync_enabled", "False") == "True"; Failure(error); }
            finally { SetBusy(false); }
        }
        string LastSyncText()
        {
            object value; if (!state.TryGetValue("last_sync", out value) || value == null) return "尚无同步记录";
            var sync = value as Dictionary<string, object>; DateTimeOffset date;
            if (sync == null || !sync.ContainsKey("finished_at") || !DateTimeOffset.TryParse(Convert.ToString(sync["finished_at"]), out date)) return "尚无同步记录";
            var elapsed = DateTimeOffset.UtcNow - date;
            string age = elapsed.TotalMinutes < 1 ? "刚刚" : elapsed.TotalHours < 1 ? (int)elapsed.TotalMinutes + " 分钟前" : elapsed.TotalDays < 1 ? (int)elapsed.TotalHours + " 小时前" : (int)elapsed.TotalDays + " 天前";
            string status = Convert.ToString(sync["status"]);
            return age + (status == "complete" ? "（完成）" : status == "partial" ? "（部分完成）" : status == "failed" ? "（失败）" : "（已结束）");
        }
        internal void Apply(Dictionary<string, object> next)
        {
            if (!next.ContainsKey("storage") && state.ContainsKey("storage")) next["storage"] = state["storage"];
            state = next; serviceLabel.Text = "后台：" + (Value("service_running", "False") == "True" ? "运行中" : "未运行") + "    上次同步结束：" + LastSyncText();
            tray.Text = "蘸饭法庭 · 后台" + (Value("service_running", "False") == "True" ? "运行中" : "未运行");
            archiveLabel.Text = "朋友：" + Value("friends", "0") + "    开黑对局：" + Value("matches", "0");
            publicationLabel.Text = "最后推送：" + DateValue("pushed_at");
            autoSyncBox.Checked = Value("sync_enabled", "False") == "True";
            autoSyncBox.Text = autoSyncBox.Checked ? "开启自动同步（已开启）" : "开启自动同步（已关闭）";
            autoSyncBox.Enabled = !busy && ready && next.ContainsKey("sync_enabled") && next["sync_enabled"] != null;
            if (!sourceDirty) { applyingSource = true; sourceChoice.SelectedIndex = Value("source_provider", "batrace") == "official" ? 1 : 0; applyingSource = false; }
            var schedule = next.ContainsKey("sync_schedule") ? next["sync_schedule"] as Dictionary<string, object> : null;
            if (schedule != null)
            {
                var hours = schedule["day_hours"] as IEnumerable;
                string dayHours = hours == null ? "—" : string.Join("、", hours.Cast<object>().Select(hour => Convert.ToInt32(hour).ToString("00") + ":00"));
                scheduleLabel.Text = "自动检查（北京时间）：白天 " + dayHours + "；" + Convert.ToInt32(schedule["fast_start_hour"]).ToString("00") + ":00～次日 " + Convert.ToInt32(schedule["fast_end_hour"]).ToString("00") + ":00 每 " + schedule["fast_minutes"] + " 分钟\n开关立即保存 · 开启后需保持后台运行";
            }
            var monitor = next.ContainsKey("request_monitor") ? next["request_monitor"] as Dictionary<string, object> : null;
            trafficLabel.Text = monitor == null ? "请求统计：暂无监控数据" : "今日可核实请求：" + monitor["today"] + " 次    正文：" + (Convert.ToInt64(monitor["unknown_bytes_today"]) > 0 ? "含历史未知" : Bytes(monitor["bytes_today"])) + "    累计至少：" + monitor["total"] + " 次";
            int firstRow = requestHistory.FirstDisplayedScrollingRowIndex;
            requestHistory.Rows.Clear();
            if (monitor != null && monitor.ContainsKey("daily")) foreach (var row in ((IEnumerable)monitor["daily"]).Cast<Dictionary<string, object>>()) requestHistory.Rows.Add(row["date"], row["requests"], row["recorded_requests"] + " / " + row["legacy_requests"] + " / " + row["supplement_requests"], Convert.ToInt64(row["unknown_bytes_requests"]) > 0 ? (Convert.ToInt64(row["bytes"]) > 0 ? Bytes(row["bytes"]) + " + 未知" : "历史未知") : Bytes(row["bytes"]), row["runs"]);
            if (monitor != null && monitor.ContainsKey("statistics")) {
                var result = (Dictionary<string, object>)monitor["statistics"]; var summary = (Dictionary<string, object>)result["summary"];
                statisticsPages = Convert.ToInt32(result["total_pages"]); statisticsPage = Convert.ToInt32(result["page"]);
                statisticsLabel.Text = result["from"] + "～" + result["to"] + " · 第 " + statisticsPage + " / " + statisticsPages + " 页 · 合计至少 " + summary["requests"] + " 次\n来源列：逐次 / 旧日志 / 补证；" + summary["unknown_bytes_requests"] + " 次历史正文未知。历史日按任务开始日期归属。";
            }
            if (next.ContainsKey("storage")) {
                var disk = (Dictionary<string, object>)next["storage"]; var volume = disk["volume"] as Dictionary<string, object>;
                storageLabel.Text = "项目文件：" + Bytes(disk["project_bytes"]) + "    数据库：" + Bytes(disk["database_bytes"]) + "\n数据目录：" + Bytes(disk["data_bytes"]) + "    其中备份：" + Bytes(disk["backup_bytes"]) + "\n站点：" + Bytes(disk["site_bytes"]) + "    磁盘可用：" + (volume == null ? "不可用" : Bytes(volume["available_bytes"])) + "\n按文件大小合计；备份已计入数据目录，跳过符号链接。";
                storageHistory.Rows.Clear(); foreach (var row in ((IEnumerable)disk["groups"]).Cast<Dictionary<string, object>>()) storageHistory.Rows.Add(row["name"], Bytes(row["bytes"]), row["files"]);
            }
            if (firstRow >= 0 && firstRow < requestHistory.Rows.Count) requestHistory.FirstDisplayedScrollingRowIndex = firstRow;
            // Background status polling must not erase an unsaved repository entry.
            if (repositoryBox.Text.Length == 0) repositoryBox.Text = Value("repository", "");
            if (!interval.Focused) { decimal n; if (decimal.TryParse(Value("interval_minutes", "120"), out n)) interval.Value = Math.Max(interval.Minimum, Math.Min(interval.Maximum, n)); }
            if (next.ContainsKey("git_available")) toolsLabel.Text = "Git：" + (Value("git_available", "False") == "True" ? "正常" : "缺失") + "    GitHub CLI：" + (Value("gh_available", "False") == "True" ? "正常" : "缺失") + "    GitHub：" + (Value("github_signed_in", "False") == "True" ? Value("github_account", "已登录") : "未登录") + "    Pages：" + Value("pages_status", "未配置");
        }
        bool ConfirmPublication(string action, string repository)
        {
            if (!consentBox.Checked) { Failure(new Exception("请先勾选公开数据确认。导出的称呼、游戏账号关联及对局明细可被他人下载。")); return false; }
            if (String.IsNullOrWhiteSpace(repository)) { Failure(new Exception("尚未配置发布仓库，请先填写仓库并完成部署。")); return false; }
            return MessageBox.Show(this, action + "\n仓库：" + repository + "\n公开内容包括朋友称呼、游戏账号关联、合格对局和单位明细。不会上传原始数据库、密码或本机配置。", "确认公开发布", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
        }
        async void Deploy()
        {
            if (!ConfirmPublication("部署并启用公开 GitHub Pages？", repositoryBox.Text.Trim())) return;
            await Operation("部署 GitHub Pages", async () => {
                var args = new List<string> { "scripts/deploy-github-pages.mjs", "--allow-public-data", "--repository", repositoryBox.Text.Trim() };
                if (createBox.Checked) args.Add("--create-public-repository"); if (restartBox.Checked) args.Add("--restart-service");
                await Node(args.ToArray()); Append("推送与 Pages 配置完成。云端构建仍可能进行中，可点击检查环境与部署。");
            });
        }
        async void Publish()
        {
            if (!CanUpdateWebsite()) return;
            await Operation("更新网页", async () => { await Node("scripts/publish-site.mjs"); Append("发布命令已完成；相同内容不会创建新提交。请检查云端构建状态。"); });
        }
        internal bool CanUpdateWebsite()
        {
            if (String.IsNullOrWhiteSpace(Value("repository", ""))) { Failure(new Exception("尚未配置发布仓库，请先填写仓库并完成首次部署。")); return false; }
            return true;
        }
        internal bool DeploymentConsentChecked { get { return consentBox.Checked; } }
        async void Login()
        {
            string gh = Runner.Tool("gh.exe"); if (gh == null) { Failure(new Exception("未找到 GitHub CLI，请使用窗口下方的官方下载入口安装。")); return; }
            await Operation("GitHub 本人登录", async () => {
                var p = Process.Start(new ProcessStartInfo(gh, "auth login --hostname github.com --git-protocol https --web") { UseShellExecute = true, WorkingDirectory = root });
                Append("GitHub 登录窗口已打开，请由本人完成浏览器授权。"); await Task.Run(() => p.WaitForExit());
                if (p.ExitCode != 0) throw new Exception("GitHub 登录没有成功完成，请重试。"); await Refresh(true);
            });
        }
        async void SelectProject()
        {
            if (busy || refreshing) return;
            using (var dialog = new FolderBrowserDialog { Description = "选择完整项目目录，或新的空目录。不会搬移现有数据库。", SelectedPath = root })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                string selected = Path.GetFullPath(dialog.SelectedPath);
                if (!Bundle.IsProject(selected) && MessageBox.Show(this, "在所选空目录释放内置程序文件？\n原项目的数据不会迁移或删除。", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
                root = selected; projectBox.Text = root; repositoryBox.Text = ""; consentBox.Checked = false; state.Clear(); ready = false; await Initialize();
            }
        }
        static void OpenUrl(string value)
        {
            Uri uri; if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || !new[] { "http", "https" }.Contains(uri.Scheme) || uri.UserInfo.Length != 0) throw new Exception("无效的网址");
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        static void OpenFolder(string value) { Process.Start(new ProcessStartInfo("explorer.exe", Runner.Quote(value)) { UseShellExecute = true }); }
        static void OpenFile(string value) { if (!File.Exists(value)) throw new FileNotFoundException("找不到文件", value); Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); }
        internal void TestReady() { ready = true; SetBusy(false); }
        internal void SaveScreenshot(string file, Size size)
        {
            StartPosition = FormStartPosition.Manual; Location = new Point(-20000, -20000);
            Size = size; if (!Visible) Show(); PerformLayout(); Application.DoEvents();
            using (var bitmap = new Bitmap(Width, Height))
            {
                DrawToBitmap(bitmap, new Rectangle(Point.Empty, Size));
                int foreground = 0;
                for (int y = 80; y < Height - 20; y += 3) for (int x = 20; x < Width - 20; x += 3)
                { Color pixel = bitmap.GetPixel(x, y); if (pixel.R < 130 && pixel.G < 130 && pixel.B < 130) foreground++; }
                if (foreground < 200) throw new Exception("Window screenshot is unexpectedly blank");
                bitmap.Save(file, System.Drawing.Imaging.ImageFormat.Png);
            }
        }
        internal void SelectTab(int index)
        {
            var tabs = Controls.OfType<TableLayoutPanel>().First().Controls.OfType<TabControl>().First();
            tabs.SelectedIndex = index; PerformLayout(); Application.DoEvents();
        }
        internal bool AllOperationButtonsDisabled() { return operations.All(b => !b.Enabled); }
    }

    static class SelfTest
    {
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);

        static void Pump()
        {
            var until = DateTime.UtcNow.AddMilliseconds(80);
            do { Application.DoEvents(); Thread.Sleep(5); } while (DateTime.UtcNow < until);
        }
        static void CheckRestored(ManagerForm form, IntPtr handle, FormWindowState expected)
        {
            Pump();
            if (form.Handle != handle) throw new Exception("Tray transition recreated the manager window handle");
            if (!form.Visible || !form.ShowInTaskbar || form.IsInTray || form.WindowState != expected || IsIconic(form.Handle) || !IsWindowVisible(form.Handle))
                throw new Exception("Manager did not restore a visible, non-minimized native window");
        }

        internal static void Run(string output)
        {
            Directory.CreateDirectory(output); string root = Path.Combine(output, "sample project"), node = Bundle.Node(root);
            Bundle.Prepare(root, s => { });
            if (File.Exists(Path.Combine(root, ".env")) || Directory.Exists(Path.Combine(root, "data")) || Directory.Exists(Path.Combine(root, "site"))) throw new Exception("Package leaked private state");
            foreach (string forbidden in new[] { "data/court.sqlite", ".env", "site/manifest.json", "../escape", "/absolute", "src/../../escape" }) if (Bundle.Allowed(forbidden)) throw new Exception("Unsafe package path accepted: " + forbidden);
            var version = Runner.Run(node, new[] { "--version" }, root, null); if (version.Code != 0 || !version.Output.StartsWith("v24.")) throw new Exception("Bundled Node runtime failed");
            File.WriteAllText(Path.Combine(root, ".env"), "HOST=127.0.0.1\nPORT=49317\nSTATIC_EXPORT_ENABLED=0\nPRIVATE_TEST_VALUE=must-not-appear-in-status\n", new UTF8Encoding(false));
            var empty = Runner.Run(node, new[] { "scripts/desktop-control.mjs", "status" }, root, null);
            if (empty.Code != 0 || empty.Output.Contains("must-not-appear")) throw new Exception("Status leaked config or failed");
            try
            {
                var start = Runner.Run(node, new[] { "scripts/service.mjs", "start" }, root, null); if (start.Code != 0) throw new Exception("Fixture service start failed: " + start.Error);
                var status = Runner.Run(node, new[] { "scripts/desktop-control.mjs", "status" }, root, null);
                var state = Bundle.Json.Deserialize<Dictionary<string, object>>(status.Output); if (!(bool)state["service_running"]) throw new Exception("Service health check failed");
                var off = Runner.Run(node, new[] { "scripts/desktop-control.mjs", "sync", "off" }, root, null);
                if (off.Code != 0 || !off.Output.Contains("false")) throw new Exception("Desktop sync pause failed: " + off.Error);
                var on = Runner.Run(node, new[] { "scripts/desktop-control.mjs", "sync", "on" }, root, null);
                if (on.Code != 0 || !on.Output.Contains("true")) throw new Exception("Desktop sync enable failed: " + on.Error);
                off = Runner.Run(node, new[] { "scripts/desktop-control.mjs", "sync", "off" }, root, null);
                if (off.Code != 0) throw new Exception("Desktop sync pause after enable failed");
                var official = Runner.Run(node, new[] { "scripts/desktop-control.mjs", "source", "official" }, root, null);
                if (official.Code != 0) throw new Exception("Official source selection failed: " + official.Error);
                var batrace = Runner.Run(node, new[] { "scripts/desktop-control.mjs", "source", "batrace" }, root, null);
                if (batrace.Code != 0) throw new Exception("BATrace source selection failed: " + batrace.Error);
                state = Bundle.Json.Deserialize<Dictionary<string, object>>(Runner.Run(node, new[] { "scripts/desktop-control.mjs", "status", "--storage" }, root, null).Output);
                if ((bool)state["sync_enabled"] || state["request_monitor"] == null) throw new Exception("Desktop traffic or saved sync state missing");
                if (state["storage"] == null || Convert.ToString(state["source_provider"]) != "batrace") throw new Exception("Storage or source status missing");
                using (var instance = new ManagerInstance(root))
                using (var form = new ManagerForm(root, true))
                {
                    if (!instance.IsPrimary) throw new Exception("Fixture manager instance already exists");
                    instance.Listen(form);
                    form.TestReady(); form.Apply(state); form.Append("本机后台已启动。测试未创建仓库或推送数据。");
                    if (form.DeploymentConsentChecked || form.CanUpdateWebsite()) throw new Exception("Unconfigured publication was allowed");
                    var configured = new Dictionary<string, object>(state); configured["repository"] = "owner/court"; form.Apply(configured);
                    if (form.DeploymentConsentChecked || !form.CanUpdateWebsite()) throw new Exception("Routine update still requires deployment consent");
                    form.SaveScreenshot(Path.Combine(output, "manager-desktop.png"), new Size(1120, 840));
                    form.SaveScreenshot(Path.Combine(output, "manager-compact.png"), new Size(950, 740));
                    form.SelectTab(3); form.SaveScreenshot(Path.Combine(output, "requests-desktop.png"), new Size(1120, 840));
                    form.SaveScreenshot(Path.Combine(output, "requests-compact.png"), new Size(950, 740));
                    form.SelectTab(4); form.SaveScreenshot(Path.Combine(output, "storage-desktop.png"), new Size(1120, 840));
                    form.SaveScreenshot(Path.Combine(output, "storage-compact.png"), new Size(950, 740));
                    form.SelectTab(1); form.SaveScreenshot(Path.Combine(output, "publish-desktop.png"), new Size(1120, 840));
                    form.SaveScreenshot(Path.Combine(output, "publish-compact.png"), new Size(950, 740));
                    form.SelectTab(2); form.SaveScreenshot(Path.Combine(output, "logs-desktop.png"), new Size(1120, 840));
                    form.SetBusy(true); if (!form.AllOperationButtonsDisabled()) throw new Exception("Busy actions were not disabled");
                    form.WindowState = FormWindowState.Minimized; Application.DoEvents();
                    if (!form.IsInTray || form.IsDisposed) throw new Exception("Minimize did not preserve the manager in the tray");
                    form.ShowManager(); Application.DoEvents();
                    if (!form.Visible || !form.ShowInTaskbar || form.WindowState != FormWindowState.Normal) throw new Exception("Tray restore did not restore the manager");
                    form.Close(); Application.DoEvents();
                    if (!form.IsInTray || form.IsDisposed) throw new Exception("Close interrupted an operation instead of hiding to the tray");
                    form.ExitManager();
                    if (form.IsDisposed) throw new Exception("Manager exited during an operation");
                    form.SetBusy(false);
                    // Exercise Windows minimize messages, not only the managed WindowState value.
                    form.ShowManager(); form.WindowState = FormWindowState.Normal; Pump();
                    var stableHandle = form.Handle;
                    for (int cycle = 0; cycle < 20; cycle++)
                    {
                        var expectedState = cycle % 2 == 0 ? FormWindowState.Normal : FormWindowState.Maximized;
                        form.WindowState = expectedState; Pump();
                        ShowWindow(form.Handle, 6); Pump();
                        if (!form.IsInTray || IsWindowVisible(form.Handle)) throw new Exception("Native minimize did not hide the manager");
                        form.ShowManager(); CheckRestored(form, stableHandle, expectedState);
                        form.ShowManager(); CheckRestored(form, stableHandle, expectedState);
                        form.Close(); Pump();
                        if (!form.IsInTray || form.IsDisposed) throw new Exception("Close did not preserve the manager");
                        form.ShowManager(); CheckRestored(form, stableHandle, expectedState);
                    }
                    form.HideToTray(); form.ExitManager(); Application.DoEvents();
                    if (!form.IsDisposed) throw new Exception("Explicit tray exit did not dispose the manager");
                }
                using (var instance = new ManagerInstance(root))
                using (var form = new ManagerForm(root, true))
                using (var duplicate = new ManagerInstance(root))
                {
                    if (!instance.IsPrimary || duplicate.IsPrimary) throw new Exception("Duplicate manager did not reuse the primary instance");
                    instance.Listen(form); form.TestReady(); form.Show(); form.HideToTray();
                    form.Failure(new Exception(new string('x', 5000)));
                    if (!form.IsInTray || form.IsDisposed) throw new Exception("Background failure opened a blocking window");
                    if (ManagerForm.ErrorSummary(new string('x', 5000)).Length > 600) throw new Exception("Failure dialog summary is unbounded");
                    var activation = Task.Run(() => duplicate.ActivateExisting(3000));
                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (!activation.IsCompleted && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(10); }
                    if (!activation.IsCompleted || !activation.Result || !form.Visible || !form.ShowInTaskbar) throw new Exception("Second launch did not restore the hidden manager");
                    var stableHandle = form.Handle;
                    for (int cycle = 0; cycle < 8; cycle++)
                    {
                        var expectedState = cycle % 2 == 0 ? FormWindowState.Normal : FormWindowState.Maximized;
                        form.WindowState = expectedState; Pump();
                        ShowWindow(form.Handle, 6); Pump();
                        var repeatedActivation = Task.Run(() => duplicate.ActivateExisting(3000));
                        var repeatDeadline = DateTime.UtcNow.AddSeconds(5);
                        while (!repeatedActivation.IsCompleted && DateTime.UtcNow < repeatDeadline) { Application.DoEvents(); Thread.Sleep(10); }
                        if (!repeatedActivation.IsCompleted || !repeatedActivation.Result) throw new Exception("Repeated launch was not acknowledged");
                        CheckRestored(form, stableHandle, expectedState);
                    }
                    form.WindowState = FormWindowState.Normal; form.Location = new Point(-20000, -20000);
                    form.HideToTray(); form.ShowManager(); CheckRestored(form, stableHandle, FormWindowState.Normal);
                    if (!Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(new Rectangle(form.Left, form.Top, form.Width, 40))))
                        throw new Exception("Restored manager title bar remained off screen");
                    form.ExitManager(); Application.DoEvents();
                }
                var afterExit = Runner.Run(node, new[] { "scripts/desktop-control.mjs", "status" }, root, null);
                if (afterExit.Code != 0 || !(bool)Bundle.Json.Deserialize<Dictionary<string, object>>(afterExit.Output)["service_running"]) throw new Exception("Tray actions stopped the backend");
                string probe = Path.Combine(root, ".desktop", "argument probe.mjs");
                File.WriteAllText(probe, "console.log(JSON.stringify(process.argv.slice(2))); console.error('expected stderr'); process.exitCode=7;", new UTF8Encoding(false));
                var expected = new[] { "含空格的参数", "quote\"value", "C:\\trailing\\" };
                var failure = Runner.Run(node, new[] { probe }.Concat(expected), root, null);
                var actual = Bundle.Json.Deserialize<string[]>(failure.Output);
                if (failure.Code != 7 || !actual.SequenceEqual(expected) || !failure.Error.Contains("expected stderr")) throw new Exception("Process arguments or error reporting failed");
                File.WriteAllText(Path.Combine(output, "result.json"), Bundle.Json.Serialize(new { ok = true, node = version.Output, checks = new[] { "safe bundle extraction", "no private data embedded", "bundled runtime", "no config leak in status", "fixture backend start/status/stop", "routine updates need no consent checkbox", "unconfigured publication remains blocked", "desktop/compact screenshots", "busy action protection", "minimize and close to tray", "restore from tray", "20 repeated native minimize/restore cycles with stable HWND", "normal and maximized state preservation", "explicit exit keeps backend running", "single manager per project", "second launch restores hidden manager", "8 repeated second-launch activations", "off-screen title bar recovery", "background failures never block in a hidden dialog", "bounded error summaries", "Unicode and quoted process arguments", "stderr and exit status" } }), Encoding.UTF8);
            }
            finally { var stop = Runner.Run(node, new[] { "scripts/service.mjs", "stop" }, root, null); if (stop.Code != 0) throw new Exception("Fixture service stop failed"); }
        }
    }
}
