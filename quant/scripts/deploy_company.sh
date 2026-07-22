#!/bin/bash
# 🥷 混沌武士量化 · 一键部署脚本
# 功能：检查环境 + 启动三机器人 + 配置PM2 + 输出状态报告

set -e

echo "🥷 混沌武士量化 · 一键部署"
echo "================================"

# 1. 环境检查
echo ""
echo "[1/5] 环境检查..."
python3 --version >/dev/null 2>&1 || { echo "❌ Python3 未安装"; exit 1; }
which pm2 >/dev/null 2>&1 || { echo "❌ PM2 未安装"; exit 1; }
echo "✅ Python3 + PM2 已就位"

# 2. 检查机器人代码
echo ""
echo "[2/5] 检查机器人代码..."
BOT20X="/root/.openclaw/workspace/bot_20x.py"
BOTKING="/root/.openclaw/workspace/bot_king.py"
HEDGEBOT="/root/.openclaw/workspace/hedge_bot.py"

[ -f "$BOT20X" ] && echo "  ✅ bot20x 存在" || echo "  ⚠️ bot20x 不存在（需新建）"
[ -f "$BOTKING" ] && echo "  ✅ bot-king 存在" || echo "  ⚠️ bot-king 不存在（需新建）"
[ -f "$HEDGEBOT" ] && echo "  ✅ hedge-bot 存在" || echo "  ⚠️ hedge-bot 不存在（v1.4待激活）"

# 3. 启动/重启机器人
echo ""
echo "[3/5] 启动机器人..."

start_bot() {
    local name=$1
    local script=$2
    if [ -f "$script" ]; then
        if pm2 list | grep -q "$name.*online"; then
            echo "  ✅ $name 已在线"
        else
            pm2 start "python3 $script" --name "$name" 2>/dev/null || pm2 restart "$name"
            echo "  🚀 $name 已启动"
        fi
    else
        echo "  ⏭️ $name 跳过（代码不存在）"
    fi
}

start_bot "bot20x" "$BOT20X"
start_bot "bot-king" "$BOTKING"

# 4. 保存PM2进程列表
echo ""
echo "[4/5] 保存PM2状态..."
pm2 save >/dev/null 2>&1 && echo "  ✅ PM2状态已保存"
pm2 startup >/dev/null 2>&1 && echo "  ✅ 开机自启已配置"

# 5. 输出状态报告
echo ""
echo "[5/5] 最终状态："
pm2 list | grep -E "bot20x|bot-king|hedge-bot" || echo "  （无在线机器人）"

echo ""
echo "================================"
echo "🥷 部署完成"
echo "📞 联系：Telegram @okbabybo"
echo "💰 收款：BSC 0x352f5Cb1CA167500D27741676ab9efA4B07D3D30"
echo "================================"
