-- 创造模式免伤（对齐 Minecraft 的手感）
--
-- 背景：Mineclonia 的伤害系统不检查创造标记，创造模式玩家照样会被怪打、
-- 摔落扣血、掉虚空死亡。这个 mod 让创造模式玩家免疫伤害，默认开启。
--
-- 开关：minetest.conf 里 `mc_creative_invulnerable = false` 可关闭。
-- 说明：虚空伤害（out_of_world）在引擎里有 bypasses_invulnerability 标记，
-- 这里通过伤害修饰器直接归零，仍然有效。

local enabled = minetest.settings:get_bool("mc_creative_invulnerable", true)

if enabled and mcl_damage and mcl_damage.register_modifier then
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
