# 更新 GitHub Pages 报告
# 用法: 把新的 HTML 报告放到桌面，然后运行此脚本
param(
    [string]$HtmlPath = ""
)

$sharedDir = "C:\Users\Administrator\shared_site"

if ($HtmlPath -eq "") {
    # 自动找桌面最新的 HTML 报告
    $latest = Get-ChildItem "$env:USERPROFILE\Desktop\*报告*.html" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) {
        Write-Host "❌ 桌面没找到报告 HTML 文件" -ForegroundColor Red
        exit 1
    }
    $HtmlPath = $latest.FullName
    Write-Host "📄 找到最新报告: $($latest.Name)" -ForegroundColor Cyan
}

Copy-Item $HtmlPath "$sharedDir\index.html" -Force
Set-Location $sharedDir
git add index.html
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
git commit -m "Update report $timestamp"
git push

Write-Host "✅ 已更新! https://arg712730.github.io/" -ForegroundColor Green
