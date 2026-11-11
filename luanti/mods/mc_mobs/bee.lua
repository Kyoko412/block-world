-- 方块世界 · 蜜蜂（原型版）
--
-- 设计目标（第一版）：
--   * 在平原/森林/繁花森林自然出现，体型小、会飞；
--   * 三条自产音效（嗡鸣/受伤/死亡），沿用我们的合成管线；
--   * 掉落蜜脾，接进现有合成；
--   * 不做蜂巢产出与授粉（下一轮），先让"世界里有蜂"这件事成立。
--
-- 模型用 cube 视觉 + 16×16 条纹贴图（.tools/bee-assets.mjs 生成，CC0），
-- 属于原型美术，后续可换 b3d。

local S = core.get_translator("mc_mobs")

local bee = {
	description = S("Bee"),
	type = "animal",
	_spawn_category = "creature",
	hp_min = 10,
	hp_max = 10,
	xp_min = 1,
	xp_max = 3,
	collisionbox = { -0.22, 0.0, -0.22, 0.22, 0.45, 0.22 },
	visual = "cube",
	textures = {
		"mc_mobs_bee.png", "mc_mobs_bee.png", "mc_mobs_bee.png",
		"mc_mobs_bee.png", "mc_mobs_bee.png", "mc_mobs_bee.png"
	},
	visual_size = { x = 0.5, y = 0.5, z = 0.5 },
	sounds = {
		random = "mc_bee_idle",
		damage = "mc_bee_hurt",
		death = "mc_bee_death",
		distance = 12,
	},
	can_despawn = false,   -- 蜜蜂不因玩家离开而消失（夜里也能在花丛看见）
	fly = true,
	fly_in = { "air" },
	fly_velocity = 2,
	movement_speed = 2.6,
	makes_footstep_sound = false,
	runaway = true,
	view_range = 12,
	drops = {
		{ name = "mcl_mobitems:honeycomb", chance = 1, min = 1, max = 2 },
	},
}

mcl_mobs.register_mob("mc_mobs:bee", bee)

-- 自然生成：平原 / 森林 / 繁花森林 / 向日葵平原，白天为主
mcl_mobs.register_spawner({
	name = "mc_mobs:bee",
	dimension = "overworld",
	type_of_spawning = "air",
	biomes = { "Plains", "Forest", "FlowerForest", "SunflowerPlains", "BirchForest" },
	min_light = 8,
	max_light = 15,
	chance = 4000,
	aoc = 6,
	min_height = 60,
	max_height = 120,
})

-- 方便试玩：/bee 在身边放一只
core.register_chatcommand("bee", {
	description = "在身边放一只蜜蜂（试玩用）",
	func = function(name)
		local player = core.get_player_by_name(name)
		if not player then return false, "需要先进入世界" end
		local pos = player:get_pos()
		local ok = mcl_mobs.spawn({ x = pos.x + 1, y = pos.y + 1.2, z = pos.z + 1 }, "mc_mobs:bee")
		return ok ~= nil, ok and "蜜蜂已生成" or "生成失败"
	end,
})
