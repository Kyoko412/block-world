-- 创造模式免伤 + 飞行/加速（对齐 Minecraft 创造模式的手感）
--
-- 背景一：Mineclonia 的伤害系统不检查创造标记，创造玩家照样会被怪打、
--         摔落扣血、掉虚空死亡。
-- 背景二：Luanti 把飞行做成 `fly` 权限，而且引擎默认 **不把 fly/fast/noclip
--         发给单人游戏**（give_to_singleplayer = false）。所以创造模式世界里
--         双击空格也飞不起来。
--
-- 这个 mod 在创造模式世界里自动授予 fly 与 fast，并让创造玩家免疫伤害。
--
-- 开关（minetest.conf）：
--   mc_creative_invulnerable = false   关闭免伤
--   mc_creative_fly = false            关闭自动授予飞行/加速
--
-- 注意：权限是按玩家存的，切回生存世界后仍然保留；不想保留可用
--   /revoke <玩家> fly fast
-- 单人游戏里 revoke 也有效，因为 fly 不是“单人默许”的权限。

local invulnerable = minetest.settings:get_bool("mc_creative_invulnerable", true)
local auto_fly = minetest.settings:get_bool("mc_creative_fly", true)

if invulnerable and mcl_damage and mcl_damage.register_modifier then
	mcl_damage.register_modifier(function(obj, damage, reason)
		if not obj or not obj:is_player() then
			return damage
		end
		if minetest.is_creative_enabled(obj:get_player_name()) then
			return 0
		end
		return damage
	end, 1000)
end

if auto_fly then
	local function grant(player)
		local name = player:get_player_name()
		if not minetest.is_creative_enabled(name) then return end
		local privs = minetest.get_player_privs(name)
		local changed = false
		if not privs.fly then privs.fly = true; changed = true end
		if not privs.fast then privs.fast = true; changed = true end
		if changed then
			minetest.set_player_privs(name, privs)
			minetest.log("action", "[mc_creative] 已为 " .. name .. " 授予 fly/fast")
		end
	end

	minetest.register_on_joinplayer(grant)
	-- 玩家在机关/命令里切换创造模式时也补一次
	minetest.register_globalstep((function()
		local acc = 0
		return function(dtime)
			acc = acc + dtime
			if acc < 2 then return end
			acc = 0
			for _, player in ipairs(minetest.get_connected_players()) do
				grant(player)
			end
		end
	end)())
end
