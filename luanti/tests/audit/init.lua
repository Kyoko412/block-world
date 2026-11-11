-- 方块世界 · 内容审计探针（L1 静态完整性 + L2 配方可执行性）
--
-- 由 scripts/audit.sh 注入到临时世界的 worldmods 里运行；结果写到世界目录 audit.txt。
-- 设计原则：只读、不改任何注册表；每项检查单独 pcall，单条失败不影响整体。

local function count(t)
	local n = 0
	for _ in pairs(t) do n = n + 1 end
	return n
end

local function push(list, name, cap)
	if #list < cap then list[#list + 1] = name end
end

-- recipe.items 形态不固定：顶层字符串、标量行、二维数组、shapeless 平铺
local function entries_of(items)
	local list = {}
	if type(items) == "string" then return { items } end
	if type(items) ~= "table" then return list end
	for _, row in ipairs(items) do
		if type(row) == "string" then
			list[#list + 1] = row
		elseif type(row) == "table" then
			for _, entry in ipairs(row) do list[#list + 1] = entry end
		end
	end
	return list
end

local function to_stacks(recipe)
	if recipe.method == "shapeless" then
		local flat = {}
		for _, entry in ipairs(entries_of(recipe.items)) do flat[#flat + 1] = ItemStack(entry) end
		return flat
	end
	local rows = {}
	if type(recipe.items) == "string" then
		rows[1] = { ItemStack(recipe.items) }
	elseif type(recipe.items) == "table" then
		for _, row in ipairs(recipe.items) do
			if type(row) == "string" then
				rows[#rows + 1] = { ItemStack(row) }
			elseif type(row) == "table" then
				local r = {}
				for _, entry in ipairs(row) do r[#r + 1] = ItemStack(entry) end
				rows[#rows + 1] = r
			end
		end
	end
	return rows
end

local function is_empty(s)
	return s == nil or s == ""
end

minetest.register_on_mods_loaded(function()
	-- 附魔变体（xxx_enchanted）由 mcl_enchanting.initialize() 动态注册；
	-- 不先调用它，交易表里的附魔物品会被误判为「未注册」。
	if mcl_enchanting and mcl_enchanting.initialize then
		pcall(mcl_enchanting.initialize)
	end
	local out = {}
	local function line(s) out[#out + 1] = s end

	local items = minetest.registered_items
	local nodes = minetest.registered_nodes
	local entities = minetest.registered_entities

	line("items=" .. count(items))
	line("nodes=" .. count(nodes))
	line("entities=" .. count(entities))

	-- ---------- L1 静态完整性 ----------
	local no_desc, no_image, node_no_sounds, tool_no_uses, food_no_sat, ent_no_tex = {}, {}, {}, {}, {}, {}
	local tools, foods, smeltable, fuels = 0, 0, 0, 0

	for name, def in pairs(items) do
		if name ~= "" and def then
			local hidden = def.groups and def.groups.not_in_creative_inventory == 1
			if is_empty(def.description) and not hidden then push(no_desc, name, 200) end

			if def.type == "node" then
				if is_empty(def.tiles) and not hidden then push(no_image, name, 200) end
				if not def.liquidtype and def.drawtype ~= "air" and not def.sounds then
					push(node_no_sounds, name, 200)
				end
			else
				if is_empty(def.inventory_image) and is_empty(def.wield_image) then
					push(no_image, name, 200)
				end
			end

			if def.type == "tool" then
				tools = tools + 1
				local caps = def.tool_capabilities
				if not caps or ((caps.max_uses or 0) == 0 and not caps.punch_attack_uses) then
					push(tool_no_uses, name, 200)
				end
			end

			if def.groups and def.groups.food and def._mcl_saturation == nil
				and (name:sub(1, 12) == "mcl_farming:" or name:sub(1, 9) == "mcl_food:") then
				push(food_no_sat, name, 200)
			end
			if def.groups and def.groups.food then foods = foods + 1 end

			-- 烹饪（熔炼）— 只统计，不做全量燃料判定
			local ok, res = pcall(minetest.get_craft_result, { method = "cooking", items = { ItemStack(name) } })
			if ok and res and res.item and not res.item:is_empty() then
				smeltable = smeltable + 1
				if not items[res.item:get_name()] then
					push(fuels, "BAD_COOK_OUTPUT:" .. name .. "->" .. res.item:get_name(), 50)
				end
			end
		end
	end

	for name, def in pairs(entities) do
		if name ~= "" and def then
			local visual = def.visual
			if (visual == "mesh" or visual == "cube" or visual == "wielditem") and is_empty(def.textures) then
				push(ent_no_tex, name, 200)
			end
		end
	end

	line("tools=" .. tools)
	line("foods=" .. foods)
	line("smeltable=" .. smeltable)

	-- ---------- L2 配方可执行性 ----------
	local recipe_ok, recipe_bad, group_skipped = 0, {}, 0
	for name in pairs(items) do
		if name ~= "" then
			local ok, list = pcall(minetest.get_all_craft_recipes, name)
			if ok and list then
				for _, recipe in ipairs(list) do
					local has_group, bad_item = false, nil
					for _, entry in ipairs(entries_of(recipe.items)) do
						if type(entry) == "string" and entry:sub(1, 6) == "group:" then
							has_group = true
						elseif type(entry) == "string" and entry ~= "" and not items[entry] then
							bad_item = entry
						end
					end
					if has_group then
						group_skipped = group_skipped + 1
					elseif bad_item then
						push(recipe_bad, name .. " 引用未注册物品 " .. bad_item, 200)
					else
						-- 实算一次，确认能产出目标物品
						local stacks = recipe.items
						local ok2, res = pcall(minetest.get_craft_result, { method = recipe.method, width = recipe.width, items = stacks })
						if ok2 and res and res.item and res.item:get_name() == name then
							recipe_ok = recipe_ok + 1
						else
							push(recipe_bad, name .. " 实算失败(" .. tostring(recipe.method) .. ")", 200)
						end
					end
				end
			end
		end
	end

	-- ---------- L2.5 掉落表与数据表 ----------
	local fish_bad, trade_bad, ench_bad = {}, {}, {}
	local fish_entries, trade_entries, ench_entries = 0, 0, 0

	for _, tbl in ipairs({ "loot_fish", "loot_junk", "loot_junk_jungle", "loot_treasure" }) do
		for _, e in ipairs((mcl_fishing and mcl_fishing[tbl]) or {}) do
			fish_entries = fish_entries + 1
			if e.itemstring then
				local resolved = ItemStack(e.itemstring):get_name()
				if not items[resolved] then push(fish_bad, tbl .. ":" .. e.itemstring, 50) end
			end
		end
	end

	for prof, tiers in pairs((mobs_mc and mobs_mc.villager_trades) or {}) do
		for _, tier in pairs(tiers) do
			for _, entry in ipairs(tier) do
				for i = 1, 2 do
					local slot = entry[i]
					if type(slot) == "table" and type(slot[1]) == "string" then
						trade_entries = trade_entries + 1
						local resolved = ItemStack(slot[1]):get_name()
						if not items[resolved] then push(trade_bad, prof .. ":" .. slot[1], 100) end
						if slot[2] and slot[3] and slot[2] > slot[3] then
							push(trade_bad, prof .. ":" .. tostring(slot[1]) .. " 数量区间反了", 100)
						end
					end
				end
			end
		end
	end

	-- 酿造：以「药水 × 酿造材料」实际调用 get_alchemy，验证产物都真实存在
	local brew_bases, brew_ingredients, brew_pairs, brew_bad = 0, 0, 0, {}
	local bases, ings = {}, {}
	for name, def in pairs(items) do
		local g = def.groups or {}
		if g.potion then bases[#bases + 1] = name
		elseif g.brewitem then ings[#ings + 1] = name end
	end
	brew_bases, brew_ingredients = #bases, #ings
	if mcl_potions and mcl_potions.get_alchemy then
		for _, base in ipairs(bases) do
			for _, ing in ipairs(ings) do
				local ok, res = pcall(mcl_potions.get_alchemy, ing, ItemStack(base))
				if ok and res and not res:is_empty() then
					brew_pairs = brew_pairs + 1
					local out = res:get_name()
					if not items[out] then
						push(brew_bad, base .. " + " .. ing .. " -> " .. out, 50)
					end
				end
			end
		end
	end
	line("brew_bases=" .. brew_bases)
	line("brew_ingredients=" .. brew_ingredients)
	line("brew_pairs=" .. brew_pairs)

	for name, def in pairs((mcl_enchanting and mcl_enchanting.enchantments) or {}) do
		ench_entries = ench_entries + 1
		if not def.name or not def.max_level or def.max_level < 1 then
			push(ench_bad, name .. " 缺 name/max_level", 50)
		end
		for inc in pairs(def.incompatible or {}) do
			if not (mcl_enchanting.enchantments or {})[inc] then
				push(ench_bad, name .. " 不兼容项不存在:" .. tostring(inc), 50)
			end
		end
	end

	line("fishing_entries=" .. fish_entries)
	line("trade_entries=" .. trade_entries)
	line("enchant_entries=" .. ench_entries)
	line("recipes_ok=" .. recipe_ok)
	line("recipes_group_skipped=" .. group_skipped)
	line("recipes_bad=" .. #recipe_bad)
	local verdict = (#recipe_bad == 0 and #node_no_sounds == 0 and #ent_no_tex == 0 and #fish_bad == 0 and #ench_bad == 0 and #brew_bad == 0) and "PASS" or "CHECK"
	line("# verdict=" .. verdict)
	line("# 待分诊样本含内部节点（light_*、*_top、*_wall、ignore）与药水/工具类，不等于缺陷")

	local function section(title, list)
		line("---" .. title .. "(" .. #list .. ")---")
		for _, v in ipairs(list) do line(v) end
	end

	section("item_no_description", no_desc)
	section("item_no_image", no_image)
	section("node_no_sounds", node_no_sounds)
	section("tool_no_uses", tool_no_uses)
	section("food_no_saturation", food_no_sat)
	section("entity_no_texture", ent_no_tex)
	section("recipe_bad", recipe_bad)
	section("fishing_bad", fish_bad)
	section("trade_bad", trade_bad)
	section("enchant_bad", ench_bad)
	section("brew_bad", brew_bad)

	local f = io.open(minetest.get_worldpath() .. "/audit.txt", "w")
	f:write(table.concat(out, "\n") .. "\n")
	f:close()

	minetest.log("action", "[audit] items=" .. count(items) .. " recipes_ok=" .. recipe_ok .. " bad=" .. #recipe_bad)
	minetest.request_shutdown()
end)
