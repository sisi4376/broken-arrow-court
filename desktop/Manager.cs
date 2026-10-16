using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
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
                Application.Run(new ManagerForm(Path.GetFullPath(root), false));
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
        string root; bool busy, refreshing, ready, testing;
        TextBox projectBox, repositoryBox, logBox;
        Label serviceLabel, archiveLabel, publicationLabel, toolsLabel, currentLabel;
        CheckBox consentBox, createBox, restartBox;
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
            tabs.TabPages.AddRange(new[] { home, publishing, logs }); layout.Controls.Add(tabs, 0, 2);
            var homeLayout = Stack(home); var publishLayout = Stack(publishing);
            serviceLabel = Status("后台：待检查", 0); archiveLabel = Status("朋友 / 对局：待检查", 0); publicationLabel = Status("最后推送：待检查", 0);
            homeLayout.Controls.Add(serviceLabel); homeLayout.Controls.Add(archiveLabel); homeLayout.Controls.Add(publicationLabel);
            var serviceRow = Row(); serviceRow.Controls.Add(Button("启动后台", async () => await Operation("启动后台", async () => await Node("scripts/service.mjs", "start"))));
            serviceRow.Controls.Add(Button("停止后台", async () => await Operation("停止后台", async () => await Node("scripts/service.mjs", "stop"))));
            serviceRow.Controls.Add(Button("重启后台", async () => await Operation("重启后台", Restart)));
            serviceRow.Controls.Add(Button("打开本机管理页", () => OpenUrl(Value("local_url", "http://127.0.0.1:4317")), false));
            serviceRow.Controls.Add(Button("打开只读预览", () => OpenUrl(Value("local_url", "http://127.0.0.1:4317") + "/readonly/"), false)); homeLayout.Controls.Add(serviceRow);
            toolsLabel = new Label { Text = "环境：待检查", AutoSize = true, Margin = new Padding(0, 12, 0, 10) }; homeLayout.Controls.Add(toolsLabel);
            var checks = Row(); checks.Controls.Add(Button("检查环境与部署", async () => await Operation("检查环境与部署", async () => await Refresh(true))));
            checks.Controls.Add(Button("登录 GitHub", Login)); checks.Controls.Add(Button("打开线上网页", () => { if (Value("public_url", "") == "") throw new Exception("尚未配置发布仓库"); OpenUrl(Value("public_url", "")); }, false)); homeLayout.Controls.Add(checks);
            var links = Row(); links.Controls.Add(Link("部署教程", () => OpenFile(Path.Combine(root, "README.md")))); links.Controls.Add(Link("Git 下载", () => OpenUrl("https://git-scm.com/downloads/win")));
            links.Controls.Add(Link("GitHub CLI 下载", () => OpenUrl("https://cli.github.com/"))); links.Controls.Add(Link("Cloudflare 控制台", () => OpenUrl("https://dash.cloudflare.com/"))); homeLayout.Controls.Add(links);
            publishLayout.Controls.Add(new Label { Text = "GitHub 仓库（用户名 / 仓库）", AutoSize = true, Margin = new Padding(0, 0, 0, 8) });
            repositoryBox = new TextBox { Dock = DockStyle.Top, Margin = new Padding(0, 0, 0, 12) }; publishLayout.Controls.Add(repositoryBox);
            createBox = new CheckBox { Text = "不存在时创建公开仓库", AutoSize = true, Margin = new Padding(0, 0, 0, 10) }; publishLayout.Controls.Add(createBox);
            var optionRow = Row(); optionRow.Controls.Add(new Label { Text = "自动推送间隔（分钟）", AutoSize = true, Margin = new Padding(0, 8, 10, 0) });
            interval = new NumericUpDown { Minimum = 5, Maximum = 10080, Value = 120, Width = 95, Margin = new Padding(0, 4, 10, 0) }; optionRow.Controls.Add(interval);
            optionRow.Controls.Add(Button("保存间隔", async () => await Operation("保存发布间隔", async () => { await Node("scripts/desktop-control.mjs", "interval", "--minutes", interval.Value.ToString()); Append("间隔已保存；重启后台后生效。"); })));
            publishLayout.Controls.Add(optionRow);
            restartBox = new CheckBox { Text = "部署成功后重启后台", AutoSize = true, Checked = true, Margin = new Padding(0, 8, 0, 12) }; publishLayout.Controls.Add(restartBox);
            consentBox = new CheckBox { Text = "同意公开称呼、账号关联、对局与单位明细", AutoSize = true, Margin = new Padding(0, 0, 0, 14) }; publishLayout.Controls.Add(consentBox);
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
            home.SizeChanged += (s, e) => { toolsLabel.MaximumSize = new Size(Math.Max(250, home.ClientSize.Width - 50), 0); publicationLabel.MaximumSize = toolsLabel.MaximumSize; };
            FormClosing += (s, e) => { if (busy) { e.Cancel = true; MessageBox.Show(this, "操作仍在执行，请等待结束后再关闭。", Text); } };
            timer.Tick += async (s, e) => { if (!busy && ready) try { await Refresh(false); } catch (Exception error) { currentLabel.Text = error.Message; } };
            if (!testing) Shown += async (s, e) => await Initialize();
        }
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
            repositoryBox.Enabled = createBox.Enabled = consentBox.Enabled = restartBox.Enabled = interval.Enabled = !value;
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
        void Failure(Exception e) { Append("失败：" + e.Message); currentLabel.Text = "操作失败，详见日志"; if (!testing) MessageBox.Show(this, e.Message, "操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
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
                var r = await Task.Run(() => Runner.Run(Bundle.Node(root), args, root, null));
                if (r.Code != 0) throw new Exception(r.Error); Apply(Bundle.Json.Deserialize<Dictionary<string, object>>(r.Output));
                if (tools) Append("环境与部署状态检查完成。");
            }
            finally { refreshing = false; }
        }
        string Value(string key, string fallback) { return state.ContainsKey(key) && state[key] != null ? state[key].ToString() : fallback; }
        string DateValue(string key) { DateTime date; return DateTime.TryParse(Value(key, ""), out date) ? date.ToLocalTime().ToString("MM-dd HH:mm:ss") : "未发布"; }
        internal void Apply(Dictionary<string, object> next)
        {
            state = next; serviceLabel.Text = "后台：" + (Value("service_running", "False") == "True" ? "运行中" : "未运行");
            archiveLabel.Text = "朋友：" + Value("friends", "0") + "    开黑对局：" + Value("matches", "0");
            publicationLabel.Text = "最后推送：" + DateValue("pushed_at");
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
            if (!ConfirmPublication("立即发布最新网页和数据？", Value("repository", ""))) return;
            await Operation("更新网页", async () => { await Node("scripts/publish-site.mjs"); Append("发布命令已完成；相同内容不会创建新提交。请检查云端构建状态。"); });
        }
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
            ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; Location = new Point(-20000, -20000);
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
                using (var form = new ManagerForm(root, true))
                {
                    form.TestReady(); form.Apply(state); form.Append("本机后台已启动。测试未创建仓库或推送数据。");
                    form.SaveScreenshot(Path.Combine(output, "manager-desktop.png"), new Size(1120, 840));
                    form.SaveScreenshot(Path.Combine(output, "manager-compact.png"), new Size(950, 740));
                    form.SelectTab(1); form.SaveScreenshot(Path.Combine(output, "publish-desktop.png"), new Size(1120, 840));
                    form.SaveScreenshot(Path.Combine(output, "publish-compact.png"), new Size(950, 740));
                    form.SelectTab(2); form.SaveScreenshot(Path.Combine(output, "logs-desktop.png"), new Size(1120, 840));
                    form.SetBusy(true); if (!form.AllOperationButtonsDisabled()) throw new Exception("Busy actions were not disabled");
                    form.SetBusy(false);
                }
                string probe = Path.Combine(root, ".desktop", "argument probe.mjs");
                File.WriteAllText(probe, "console.log(JSON.stringify(process.argv.slice(2))); console.error('expected stderr'); process.exitCode=7;", new UTF8Encoding(false));
                var expected = new[] { "含空格的参数", "quote\"value", "C:\\trailing\\" };
                var failure = Runner.Run(node, new[] { probe }.Concat(expected), root, null);
                var actual = Bundle.Json.Deserialize<string[]>(failure.Output);
                if (failure.Code != 7 || !actual.SequenceEqual(expected) || !failure.Error.Contains("expected stderr")) throw new Exception("Process arguments or error reporting failed");
                File.WriteAllText(Path.Combine(output, "result.json"), Bundle.Json.Serialize(new { ok = true, node = version.Output, checks = new[] { "safe bundle extraction", "no private data embedded", "bundled runtime", "no config leak in status", "fixture backend start/status/stop", "desktop/compact screenshots", "busy action protection", "Unicode and quoted process arguments", "stderr and exit status" } }), Encoding.UTF8);
            }
            finally { var stop = Runner.Run(node, new[] { "scripts/service.mjs", "stop" }, root, null); if (stop.Code != 0) throw new Exception("Fixture service stop failed"); }
        }
    }
}
