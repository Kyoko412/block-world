-- 方块世界 · L3 验收地图（v3，最简可靠版）
--
-- 进入世界后自动生成平台：12 个编号站台、一个水池、一段矿车轨道、两只测试怪。
-- 站台不放告示牌/箱子（避免容器与元数据初始化问题），全部靠聊天命令：
--   /l3        打印清单与每个站台的坐标
--   /l3kit N   领取第 N 个站台需要的道具
--
-- 生成方式：
--   bash luanti/scripts/make-l3-world.sh   # 建世界
--   服务端加 l3_autobuild = true 可无头建图（测试用）

local BASE_Y = 120
local SIZE = 44
local MARK = { x = 0, y = BASE_Y + 1, z = 0 }

local STATIONS = {
	{ 1, -14, -14, "合成/熔炼" }, { 2, -6, -14, "进食" },
	{ 3, 2, -14, "装备" }, { 4, 10, -14, "酿造" },
	{ 5, -14, -6, "附魔" }, { 6, -6, -6, "交易" },
	{ 7, 2, -6, "钓鱼" }, { 8, 10, -6, "床" },
	{ 9, -14, 2, "船/矿车" }, { 10, -6, 2, "战斗" },
	{ 11, 2, 2, "红石" }, { 12, 10, 2, "退出重进" },
}

local KITS = {
	[1] = { "mcl_core:iron_ore 8", "mcl_core:coal_lump 8", "mcl_core:wood 8", "mcl_crafting_table:crafting_table 1", "mcl_furnaces:furnace 1" },
	[2] = { "mcl_farming:bread 8", "mcl_food:beef_cooked 8", "mcl_core:apple 8", "mcl_potions:water 2" },
	[3] = { "mcl_armor:helmet_iron 1", "mcl_armor:chestplate_iron 1", "mcl_armor:leggings_iron 1", "mcl_armor:boots_iron 1",
	        "mcl_tools:sword_iron 1", "mcl_shields:shield 1", "mcl_bows:bow 1", "mcl_bows:arrow 16" },
	[4] = { "mcl_potions:glass_bottle 6", "mcl_nether:nether_wart 8", "mcl_nether:glowstone_dust 8",
	        "mcl_mobitems:gunpowder 8", "mcl_brewing:stand 1" },
	[5] = { "mcl_core:lapis 16", "mcl_tools:pick_iron 1", "mcl_tools:sword_diamond 1", "mcl_books:bookshelf 8", "mcl_enchanting:table 1" },
	[6] = { "mcl_core:emerald 16" },
	[7] = { "mcl_fishing:fishing_rod 1" },
	[8] = { "mcl_beds:bed_red 1" },
	[9] = { "mcl_boats:boat 1", "mcl_minecarts:minecart 1", "mcl_minecarts:rail 16" },
	[10] = { "mcl_tools:sword_diamond 1", "mcl_armor:chestplate_diamond 1" },
	[11] = { "mcl_redstone:redstone 8" },
	[12] = {},
}

local COLORS = { "red", "orange", "yellow", "green", "cyan", "blue",
                 "purple", "magenta", "pink", "white", "grey", "black" }

local function log(msg)
	minetest.log("action", "[l3] " .. tostring(msg))
end

local function place(pos, name)
	if not minetest.registered_nodes[name] then
		return false
	end
	minetest.set_node(pos, { name = name })
	return true
end

local function build()
	-- 先清空平台上方 5 层，避免平台埋在雪山里
	for x = -SIZE / 2, SIZE / 2 do
		for z = -SIZE / 2, SIZE / 2 do
			place({ x = x, y = BASE_Y, z = z }, "mcl_core:stonebrick")
			for y = BASE_Y + 1, BASE_Y + 5 do
				place({ x = x, y = y, z = z }, "air")
			end
		end
	end

	local placed = 0
	for id, x, z, label in ipairs(STATIONS) do
		local color = COLORS[id] or "white"
		local wool = "mcl_wool:" .. color
		local ok = place({ x = x, y = BASE_Y + 1, z = z }, "mcl_core:stonebrick")
		if minetest.registered_nodes[wool] then
			place({ x = x, y = BASE_Y + 2, z = z }, wool)
		end
		if ok then placed = placed + 1 end
	end

	-- 水池（站台 7 附近）
	for x = 0, 4 do
		for z = 0, 4 do
			place({ x = 4 + x, y = BASE_Y, z = -6 + z }, "mcl_core:water_source")
		end
	end

	-- 矿车轨道（站台 9 附近）
	for x = 0, 7 do
		place({ x = -16 + x, y = BASE_Y + 1, z = 6 }, "mcl_minecarts:rail")
	end

	place(MARK, "mcl_core:goldblock")

	-- 战斗测试怪
	pcall(minetest.add_entity, { x = -6, y = BASE_Y + 1, z = 6 }, "mobs_mc:zombie")
	pcall(minetest.add_entity, { x = -2, y = BASE_Y + 1, z = 6 }, "mobs_mc:skeleton")

	log(("platform built stations=%d"):format(placed))
end

minetest.register_on_mods_loaded(function()
	if not minetest.settings:get_bool("l3_autobuild") then return end
	local ok, err = pcall(minetest.load_area,
		{ x = -22, y = BASE_Y - 2, z = -22 }, { x = 22, y = BASE_Y + 6, z = 22 })
	if not ok then log("load_area failed: " .. tostring(err)); return end
	local built, berr = pcall(build)
	log(built and "autobuild done" or ("autobuild failed: " .. tostring(berr)))
end)

minetest.register_on_joinplayer(function(player)
	if minetest.get_node(MARK).name ~= "mcl_core:goldblock" then
		local ok, err = pcall(build)
		if not ok then log("build failed: " .. tostring(err)) return end
	end
	-- 每次进入都送到平台上（世界出生点还在地形表面）
	player:set_pos({ x = 0, y = BASE_Y + 2, z = 0 })
end)

minetest.register_chatcommand("l3kit", {
	params = "<1-12>",
	description = "领取某个站台需要的道具",
	func = function(name, param)
		local id = tonumber(param)
		local kit = id and KITS[id]
		if not kit then return false, "用法：/l3kit 1..12" end
		local player = minetest.get_player_by_name(name)
		if not player then return false, "需要进入世界" end
		local inv = player:get_inventory()
		for _, item in ipairs(kit) do
			local left = inv:add_item("main", ItemStack(item))
			if left and not left:is_empty() then
				minetest.add_item(player:get_pos(), left)
			end
		end
		return true, ("已发放站台 %d 的道具（%d 件）"):format(id, #kit)
	end,
})

local CHECKLIST = {
	"1 合成/熔炼：工作台做木镐；熔炉把铁矿烧成铁锭",
	"2 进食：吃面包/熟肉，饥饿条下降、回血生效",
	"3 装备：穿全套铁甲，护甲条出现；剑/盾/弓可用",
	"4 酿造：水瓶 + 地狱疣 → 粗制药水；加萤石/火药有变化",
	"5 附魔：附魔台放剑/镐，消耗青金石，出现附魔",
	"6 交易：右键村民，能打开交易界面并成交",
	"7 钓鱼：甩竿入水，浮标下沉时右键能钓上东西",
	"8 床：夜晚右键床，能跳过夜晚并设置重生点",
	"9 船/矿车：船能下水划动；矿车能坐上并沿轨移动",
	"10 战斗：僵尸/骷髅会追打；受击有反馈、死亡有掉落",
	"11 红石：拉杆能点亮红石灯（可选）",
	"12 退出重进：世界正常加载，背包与进度保留",
}

minetest.register_chatcommand("l3", {
	description = "打印 L3 验收清单与站台坐标",
	func = function()
		local lines = { "=== L3 验收清单（站台坐标）===" }
		for _, s in ipairs(STATIONS) do
			lines[#lines + 1] = ("%2d %-8s x=%d z=%d"):format(s[1], s[4], s[2], s[3])
		end
		lines[#lines + 1] = "------"
		for _, line in ipairs(CHECKLIST) do lines[#lines + 1] = line end
		return true, table.concat(lines, "\n")
	end,
})
