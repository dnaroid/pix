$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class UiQaWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

    [DllImport("user32.dll", SetLastError=true)]
    static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;

    static INPUT Key(ushort vk, ushort scan, uint flags) {
        var input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = vk;
        input.U.ki.wScan = scan;
        input.U.ki.dwFlags = flags;
        return input;
    }

    public static void SendUnicodeText(string text) {
        foreach (char ch in text) {
            var inputs = new [] {
                Key(0, ch, KEYEVENTF_UNICODE),
                Key(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            };
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
                throw new InvalidOperationException("SendInput failed while typing text");
        }
    }

    public static void SendKeyChord(ushort key, ushort[] modifiers) {
        var inputs = new System.Collections.Generic.List<INPUT>();
        foreach (var modifier in modifiers) inputs.Add(Key(modifier, 0, 0));
        inputs.Add(Key(key, 0, 0));
        inputs.Add(Key(key, 0, KEYEVENTF_KEYUP));
        for (int i = modifiers.Length - 1; i >= 0; i--) inputs.Add(Key(modifiers[i], 0, KEYEVENTF_KEYUP));
        var value = inputs.ToArray();
        if (SendInput((uint)value.Length, value, Marshal.SizeOf(typeof(INPUT))) != value.Length)
            throw new InvalidOperationException("SendInput failed while sending key chord");
    }

    public static void ClickPoint(int x, int y) {
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }

    public static void CaptureWindow(IntPtr hwnd, string file) {
        RECT rect;
        if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out rect))
            throw new InvalidOperationException("could not resolve target window rectangle");
        int width = Math.Max(1, rect.Right - rect.Left);
        int height = Math.Max(1, rect.Bottom - rect.Top);
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                IntPtr hdc = graphics.GetHdc();
                bool printed = false;
                try { printed = PrintWindow(hwnd, hdc, 2); }
                finally { graphics.ReleaseHdc(hdc); }
                if (!printed) graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height));
            }
            bitmap.Save(file, ImageFormat.Png);
        }
    }
}
'@

function Fail([string]$Message) {
    [Console]::Error.WriteLine($Message)
    exit 1
}

function Parse-Options([string[]]$Values) {
    $result = @{}
    $index = 0
    while ($index -lt $Values.Count) {
        $key = $Values[$index]
        if (-not $key.StartsWith("--")) { Fail "unexpected argument: $key" }
        $name = $key.Substring(2)
        if ($name -eq "all") {
            $result[$name] = $true
            $index += 1
            continue
        }
        if ($index + 1 -ge $Values.Count) { Fail "missing value for $key" }
        if ($result.ContainsKey($name)) { Fail "duplicate option: $key" }
        $result[$name] = $Values[$index + 1]
        $index += 2
    }
    return $result
}

function Require-Option($Options, [string]$Name) {
    if (-not $Options.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace([string]$Options[$Name])) {
        Fail "missing --$Name"
    }
    return [string]$Options[$Name]
}

function Control-Role([System.Windows.Automation.AutomationElement]$Element) {
    $programmatic = $Element.Current.ControlType.ProgrammaticName
    if ($programmatic -and $programmatic.Contains(".")) { return $programmatic.Split(".")[-1] }
    return [string]$programmatic
}

function Scalar-String($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [bool]) { return $Value.ToString().ToLowerInvariant() }
    return [string]$Value
}

function Element-Attributes([System.Windows.Automation.AutomationElement]$Element) {
    $attributes = [ordered]@{}
    if (-not [string]::IsNullOrEmpty($Element.Current.Name)) { $attributes.title = $Element.Current.Name }
    if (-not [string]::IsNullOrEmpty($Element.Current.ItemStatus)) { $attributes.description = $Element.Current.ItemStatus }
    if (-not [string]::IsNullOrEmpty($Element.Current.AutomationId)) { $attributes.identifier = $Element.Current.AutomationId }
    if (-not [string]::IsNullOrEmpty($Element.Current.HelpText)) { $attributes.help = $Element.Current.HelpText }
    if ($Element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $Element.Current.IsPassword) {
        $attributes.value = "<redacted>"
    } else {
        $pattern = $null
        if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $attributes.value = ([System.Windows.Automation.ValuePattern]$pattern).Current.Value
        } else {
            $toggle = $null
            if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
                $attributes.value = ([System.Windows.Automation.TogglePattern]$toggle).Current.ToggleState.ToString()
            }
        }
    }
    $attributes.enabled = Scalar-String $Element.Current.IsEnabled
    $attributes.focused = Scalar-String $Element.Current.HasKeyboardFocus
    $selection = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
        $attributes.selected = Scalar-String ([System.Windows.Automation.SelectionItemPattern]$selection).Current.IsSelected
    }
    return $attributes
}

function Element-Record([System.Windows.Automation.AutomationElement]$Element, [string]$Path) {
    $rect = $Element.Current.BoundingRectangle
    return [ordered]@{
        path = $Path
        role = Control-Role $Element
        attributes = Element-Attributes $Element
        frame = [ordered]@{
            x = [int][math]::Round($rect.X)
            y = [int][math]::Round($rect.Y)
            width = [int][math]::Round($rect.Width)
            height = [int][math]::Round($rect.Height)
        }
    }
}

function Get-Children([System.Windows.Automation.AutomationElement]$Element) {
    $result = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $child = $walker.GetFirstChild($Element)
    while ($null -ne $child) {
        $result.Add($child)
        $child = $walker.GetNextSibling($child)
    }
    return $result
}

function Get-DescendantPids([int]$OwnerPid) {
    $wanted = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$wanted.Add($OwnerPid)
    try {
        $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($process in $processes) {
                if ($wanted.Contains([int]$process.ParentProcessId) -and -not $wanted.Contains([int]$process.ProcessId)) {
                    [void]$wanted.Add([int]$process.ProcessId)
                    $changed = $true
                }
            }
        }
    } catch {
        # Exact owner PID remains a safe fallback if WMI/CIM is unavailable.
    }
    return $wanted
}

function Find-AppWindow($Options) {
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $matches = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
    $pids = $null
    if ($Options.ContainsKey("pid")) {
        $pids = New-Object 'System.Collections.Generic.HashSet[int]'
        [void]$pids.Add([int](Require-Option $Options "pid"))
    } elseif ($Options.ContainsKey("owner-pid")) {
        $pids = Get-DescendantPids ([int](Require-Option $Options "owner-pid"))
    }
    $name = if ($Options.ContainsKey("app")) { [string]$Options.app } else { $null }
    $title = if ($Options.ContainsKey("title")) { [string]$Options.title } else { $null }
    foreach ($root in $roots) {
        if ($pids -and -not $pids.Contains([int]$root.Current.ProcessId)) { continue }
        if ($title -and $root.Current.Name -ne $title) { continue }
        if ($name) {
            $processName = ""
            try { $processName = (Get-Process -Id $root.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}
            if ($root.Current.Name.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
                $processName.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        }
        $matches.Add($root)
    }
    if ($matches.Count -eq 0) { return $null }
    if ($matches.Count -gt 1 -and -not $pids -and -not $title) { Fail "ambiguous app selector ($($matches.Count) windows); use --pid" }
    return $matches[0]
}

function Wait-AppWindow($Options, [double]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $window = Find-AppWindow $Options
        if ($null -ne $window) { return $window }
        Start-Sleep -Milliseconds 100
    }
    Fail "timed out waiting for application window"
}

function Focus-Window([System.Windows.Automation.AutomationElement]$Window) {
    $handle = [IntPtr]$Window.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
        [void][UiQaWin32]::ShowWindow($handle, 9)
        [void][UiQaWin32]::SetForegroundWindow($handle)
    }
    try { $Window.SetFocus() } catch {}
}

function Walk-Tree([System.Windows.Automation.AutomationElement]$Root, [int]$Depth, [int]$Limit) {
    $records = New-Object System.Collections.Generic.List[object]
    function Visit($Element, [string]$Path, [int]$Level) {
        if ($records.Count -ge $Limit) { return }
        $records.Add((Element-Record $Element $Path))
        if ($Level -ge $Depth) { return }
        $children = @(Get-Children $Element)
        for ($index = 0; $index -lt $children.Count; $index++) {
            Visit $children[$index] "$Path/$index" ($Level + 1)
            if ($records.Count -ge $Limit) { return }
        }
    }
    Visit $Root "0" 0
    return $records
}

function Find-Element([System.Windows.Automation.AutomationElement]$Window, $Options) {
    if ($Options.ContainsKey("path")) {
        $parts = ([string]$Options.path).Split('/') | Where-Object { $_ -ne "" }
        $current = $Window
        $start = if ($parts.Count -gt 0 -and $parts[0] -eq "0") { 1 } else { 0 }
        for ($index = $start; $index -lt $parts.Count; $index++) {
            $childIndex = 0
            if (-not [int]::TryParse($parts[$index], [ref]$childIndex)) { Fail "invalid element path" }
            $children = @(Get-Children $current)
            if ($childIndex -lt 0 -or $childIndex -ge $children.Count) { Fail "element path does not exist" }
            $current = $children[$childIndex]
        }
        return $current
    }
    $match = Require-Option $Options "match"
    $role = if ($Options.ContainsKey("role")) { ([string]$Options.role).Replace("AX", "") } else { $null }
    $occurrence = if ($Options.ContainsKey("occurrence")) { [int]$Options.occurrence } else { 1 }
    $seen = 0
    foreach ($record in (Walk-Tree $Window 20 1000)) {
        $path = [string]$record.path
        $element = Find-Element $Window @{ path = $path }
        $attributes = Element-Attributes $element
        $text = @($attributes.title, $attributes.description, $attributes.identifier, $attributes.help, $attributes.value) -join " "
        if ($text.IndexOf($match, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        if ($role -and (Control-Role $element) -ne $role) { continue }
        $seen += 1
        if ($seen -eq $occurrence) { return $element }
    }
    Fail "no accessibility element matches the supplied selector"
}

function Format-InspectRecord($Record) {
    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add([string]$Record.path)
    $parts.Add([string]$Record.role)
    foreach ($entry in $Record.attributes.GetEnumerator()) {
        if ($null -eq $entry.Value -or [string]::IsNullOrEmpty([string]$entry.Value)) { continue }
        $safe = ([string]$entry.Value).Replace("`r", " ").Replace("`n", " ").Replace('"', '\"')
        $parts.Add("$($entry.Key)=`"$safe`"")
    }
    $frame = $Record.frame
    $parts.Add("frame=$($frame.x),$($frame.y),$($frame.width)x$($frame.height)")
    return $parts -join " "
}

function Invoke-Element([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        ([System.Windows.Automation.InvokePattern]$pattern).Invoke(); return
    }
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        ([System.Windows.Automation.SelectionItemPattern]$pattern).Select(); return
    }
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        ([System.Windows.Automation.TogglePattern]$pattern).Toggle(); return
    }
    $rect = $Element.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { Fail "element has no actionable accessibility pattern or visible frame" }
    [UiQaWin32]::ClickPoint([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
}

function Key-Code([string]$Name) {
    $map = @{
        enter=0x0D; return=0x0D; escape=0x1B; esc=0x1B; tab=0x09; backspace=0x08;
        delete=0x2E; left=0x25; up=0x26; right=0x27; down=0x28; home=0x24; end=0x23;
        pageup=0x21; pagedown=0x22; space=0x20
    }
    $lower = $Name.ToLowerInvariant()
    if ($map.ContainsKey($lower)) { return [ushort]$map[$lower] }
    if ($Name.Length -eq 1) { return [ushort][char]$Name.ToUpperInvariant() }
    Fail "unsupported key: $Name"
}

function Modifier-Codes([string]$Value) {
    $result = New-Object System.Collections.Generic.List[ushort]
    if ([string]::IsNullOrWhiteSpace($Value)) { return $result.ToArray() }
    foreach ($raw in $Value.Split(',')) {
        switch ($raw.Trim().ToLowerInvariant()) {
            "cmd" { $result.Add([ushort]0x5B) }
            "shift" { $result.Add([ushort]0x10) }
            "ctrl" { $result.Add([ushort]0x11) }
            "opt" { $result.Add([ushort]0x12) }
            "alt" { $result.Add([ushort]0x12) }
            "fn" { Fail "fn modifier is not supported by the Windows UI Automation helper" }
            default { Fail "unsupported modifier: $raw" }
        }
    }
    return $result.ToArray()
}

if ($args.Count -lt 1) { Fail "missing command" }
$command = [string]$args[0]
$options = Parse-Options @($args | Select-Object -Skip 1)

if ($command -eq "doctor") {
    try {
        [void][System.Windows.Automation.AutomationElement]::RootElement
        Write-Output "uia=available"
        Write-Output "screenshot=available"
        exit 0
    } catch {
        Fail "Windows UI Automation is unavailable: $($_.Exception.Message)"
    }
}

$timeout = if ($options.ContainsKey("timeout")) { [double]$options.timeout } else { 15.0 }
$window = Wait-AppWindow $options $timeout

switch ($command) {
    "wait-window" {
        if ($options.ContainsKey("print-pid")) { Write-Output $window.Current.ProcessId }
    }
    "focus" { Focus-Window $window }
    "inspect" {
        $depth = if ($options.ContainsKey("depth")) { [int]$options.depth } else { 10 }
        $limit = if ($options.ContainsKey("limit")) { [int]$options.limit } else { 80 }
        foreach ($record in (Walk-Tree $window $depth $limit)) { Write-Output (Format-InspectRecord $record) }
    }
    "describe" {
        $element = Find-Element $window $options
        (Element-Record $element (if ($options.ContainsKey("path")) { [string]$options.path } else { "match" })) | ConvertTo-Json -Compress -Depth 5
    }
    "screenshot" {
        $out = Require-Option $options "out"
        $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($out))
        if (-not [IO.Directory]::Exists($directory)) { Fail "screenshot output directory does not exist" }
        [UiQaWin32]::CaptureWindow([IntPtr]$window.Current.NativeWindowHandle, $out)
    }
    "click" { Invoke-Element (Find-Element $window $options) }
    "set-value" {
        $element = Find-Element $window $options
        $value = Require-Option $options "value"
        $pattern = $null
        if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { Fail "element does not support ValuePattern" }
        ([System.Windows.Automation.ValuePattern]$pattern).SetValue($value)
    }
    "type" {
        Focus-Window $window
        [UiQaWin32]::SendUnicodeText((Require-Option $options "text"))
    }
    "key" {
        Focus-Window $window
        $mods = if ($options.ContainsKey("modifiers")) { Modifier-Codes ([string]$options.modifiers) } else { [ushort[]]@() }
        [UiQaWin32]::SendKeyChord((Key-Code (Require-Option $options "key")), $mods)
    }
    default { Fail "unsupported command: $command" }
}
