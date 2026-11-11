-- 方块世界 · 配乐与提示音（Luanti 版）
--
-- 上游 Mineclonia 没有游戏内音乐，所以这层是我们的独占身份：
--   * 三首原创曲目按场景切换（白天 / 夜晚 / 洞穴），单声道 OGG；
--   * 首次入场留白 14—28 秒，曲间留白 110—190 秒，不铺满；
--   * 6 秒缓入，不做硬切；
--   * 提示音 8 条，接在合成/拾取/升级等真实事件上。
--
-- 没有总线：Luanti 只有每音效 gain，所以这里统一用 mc_music_gain 控总音量。

local TRACKS = {
  day = { sound = "mc_music_day", seconds = 81 },
  night = { sound = "mc_music_night", seconds = 96 },
  cave = { sound = "mc_music_cave", seconds = 87 }
}
local LEAD_MIN, LEAD_MAX = 14, 28
local GAP_MIN, GAP_MAX = 110, 190
local FADE_SECONDS = 6
local CAVE_Y = 24

local gain = tonumber(minetest.settings:get("mc_music_gain")) or 0.55
local enabled = minetest.settings:get_bool("mc_music_enabled", true)
local states = {}

local function rand_range(a, b) return a + math.random() * (b - a) end

local function scene_of(player)
  local pos = player:get_pos()
  if not pos then return "day" end
  if pos.y < CAVE_Y and (minetest.get_node_light(pos) or 0) < 8 then return "cave" end
  local t = minetest.get_timeofday()
  if t < 0.23 or t > 0.77 then return "night" end
  return "day"
end

local function stop(state, player_name)
  if state.handle then minetest.sound_stop(state.handle) end
  state.handle = nil
  state.playing = false
  state.playing_until = nil
end

local function start(state, player_name, scene)
  local track = TRACKS[scene]
  if not track then return end
  state.scene = scene
  local h = minetest.sound_play(track.sound, {
    to_player = player_name,
    gain = gain,
    fade = gain / FADE_SECONDS
  })
  state.handle = h
  state.playing = true
  local now = minetest.get_gametime()
  state.playing_until = now + track.seconds
  minetest.log("action", "[mc_music] 开始播放 " .. scene .. " → " .. player_name)
end

local function tick()
  if not enabled then return end
  local now = minetest.get_gametime()
  for _, player in ipairs(minetest.get_connected_players()) do
    local name = player:get_player_name()
    local state = states[name]
    if state then
      if state.playing and now >= state.playing_until then
        stop(state, name)
        state.next_at = now + rand_range(GAP_MIN, GAP_MAX)
      end
      if not state.playing and now >= state.next_at then
        start(state, name, scene_of(player))
      end
    end
  end
end

minetest.register_on_joinplayer(function(player)
  local name = player:get_player_name()
  states[name] = {
    scene = scene_of(player),
    next_at = minetest.get_gametime() + rand_range(LEAD_MIN, LEAD_MAX)
  }
end)

minetest.register_on_leaveplayer(function(player)
  local name = player:get_player_name()
  local state = states[name]
  if state then stop(state, name) end
  states[name] = nil
end)

minetest.register_globalstep(function(dtime)
  tick()
end)

-- 提示音：接在真实事件上，不额外造事件
local function cue(name, player_name)
  if not player_name then return end
  minetest.sound_play("mc_cue_" .. name, { to_player = player_name, gain = 0.7 }, true)
end

minetest.register_on_craft(function(itemstack, player)
  if player then cue("craft", player:get_player_name()) end
end)

minetest.register_on_player_receive_fields(function(player)
  -- 打开/关闭界面时的轻提示；频率受限，不刷屏
  local name = player:get_player_name()
  local now = minetest.get_gametime()
  states[name] = states[name] or {}
  if (states[name].last_ui or -99) + 0.4 < now then
    states[name].last_ui = now
    cue("click", name)
  end
end)

-- 便于自检：/music 查看状态或开关
minetest.register_chatcommand("music", {
  params = "[on|off|status]",
  description = "配乐开关与状态",
  func = function(name, param)
    if param == "off" then
      enabled = false
      local state = states[name]
      if state then stop(state, name) end
      return true, "配乐已关闭"
    elseif param == "on" then
      enabled = true
      local player = minetest.get_player_by_name(name)
      local state = states[name]
      if player and state then state.next_at = minetest.get_gametime() + 2 end
      return true, "配乐已开启"
    end
    local state = states[name] or {}
    return true, string.format("场景=%s 播放中=%s 增益=%.2f 曲目=%s",
      tostring(state.scene), tostring(state.playing == true), gain, TRACKS[state.scene or "day"].sound)
  end
})
