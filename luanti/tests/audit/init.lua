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
			if is_empty(def.description) then push(no_desc, name, 200) end

			if def.type == "node" then
				if is_empty(def.tiles) then push(no_image, name, 200) end
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

			if def.groups and def.groups.food and def._mcl_saturation == nil then
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

	line("recipes_ok=" .. recipe_ok)
	line("recipes_group_skipped=" .. group_skipped)
	line("recipes_bad=" .. #recipe_bad)
	local verdict = (#recipe_bad == 0 and #node_no_sounds == 0 and #ent_no_tex == 0) and "PASS" or "CHECK"
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

	local f = io.open(minetest.get_worldpath() .. "/audit.txt", "w")
	f:write(table.concat(out, "\n") .. "\n")
	f:close()

	minetest.log("action", "[audit] items=" .. count(items) .. " recipes_ok=" .. recipe_ok .. " bad=" .. #recipe_bad)
	minetest.request_shutdown()
end)
