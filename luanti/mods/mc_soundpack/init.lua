-- 方块世界 · Luanti 声音包（移动 / 挖掘 / 破坏 / 放置）
--
-- 做法：不改 Mineclonia 的任何一行代码，只在所有模组加载完之后，把已注册节点的
-- 声音表按「按键位」重映射到我们自己的声音组。
--   * footstep/dig/dug/place 分开映射：Mineclonia 里同一组名会在不同键位复用
--     （例如石头 dug 也用 default_hard_footstep），按名字一刀切会把破坏声变成脚步声。
--   * 声音组是 Luanti 原生能力：mc_dig_stone.ogg / .0 / .1 / .2 由引擎随机挑一条，
--     正好对应我们 _b/_c/_d 的变体，不需要写轮换逻辑。
--   * player_damage / player_falling_damage / player_jump 是引擎内置特殊组，
--     对应文件已放在 sounds/ 里，不用在这里登记。

local FOOT = {
  ["default_hard_footstep"] = "mc_step_stone",
  ["default_dirt_footstep"] = "mc_step_grass",
  ["default_grass_footstep"] = "mc_step_grass",
  ["default_wood_footstep"] = "mc_step_wood",
  ["default_sand_footstep"] = "mc_step_sand",
  ["default_gravel_footstep"] = "mc_step_sand",
  ["default_metal_footstep"] = "mc_step_stone",
  ["default_glass_footstep"] = "mc_step_stone",
  ["default_ice_footstep"] = "mc_step_snow",
  ["default_water_footstep"] = "mc_step_grass"
}

local DIG = {
  ["default_dig_cracky"] = "mc_dig_stone",
  ["default_dig_crumbly"] = "mc_dig_dirt",
  ["default_dig_choppy"] = "mc_dig_wood",
  ["default_dig_snappy"] = "mc_dig_grass",
  ["default_dig_oddly_breakable_by_hand"] = "mc_dig_grass",
  ["default_dig_metal"] = "mc_dig_stone",
  ["default_gravel_dig"] = "mc_dig_gravel",
  ["default_ice_dig"] = "mc_dig_stone"
}

local DUG = {
  ["default_dug_node"] = "mc_break_dirt",
  ["default_dug_metal"] = "mc_break_stone",
  ["default_gravel_dug"] = "mc_break_sand",
  ["default_ice_dug"] = "mc_break_stone",
  ["default_hard_footstep"] = "mc_break_stone",   -- 石头被破坏时复用了脚步声组名
  ["default_dirt_footstep"] = "mc_break_dirt",
  ["default_grass_footstep"] = "mc_break_grass",
  ["default_wood_footstep"] = "mc_break_wood",
  ["default_sand_footstep"] = "mc_break_sand",
  ["default_gravel_footstep"] = "mc_break_sand",
  ["default_snappy_footstep"] = "mc_break_grass"
}

local PLACE = {
  ["default_place_node"] = "mc_place_dirt",
  ["default_place_node_hard"] = "mc_place_stone",
  ["default_place_node_metal"] = "mc_place_stone",
  ["default_place_node_lava"] = "mc_place_stone"
}

local MAPS = { footstep = FOOT, dig = DIG, dug = DUG, place = PLACE }

local function patched(entry, map)
  if type(entry) == "string" then
    return map[entry] and { name = map[entry] } or nil
  end
  if type(entry) == "table" and type(entry.name) == "string" and map[entry.name] then
    local copy = {}
    for k, v in pairs(entry) do copy[k] = v end
    copy.name = map[entry.name]
    return copy
  end
  return nil
end

local function apply()
  local changed, keys = 0, 0
  for name, def in pairs(minetest.registered_nodes) do
    if def.sounds then
      local out, touched = {}, false
      for k, v in pairs(def.sounds) do out[k] = v end
      for key, map in pairs(MAPS) do
        local replacement = patched(out[key], map)
        if replacement then
          out[key] = replacement
          touched = true
          keys = keys + 1
        end
      end
      if touched then
        minetest.override_item(name, { sounds = out })
        changed = changed + 1
      end
    end
  end
  minetest.log("action", "[mc_soundpack] 已重映射 " .. changed .. " 个节点、共 " .. keys .. " 个声音键位")
end

minetest.register_on_mods_loaded(apply)
