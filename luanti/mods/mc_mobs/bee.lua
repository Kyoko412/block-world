-- 方块世界 · 蜜蜂。蜂量由这里管理，蜜量和采收仍由 mcl_beehives 管理。

local S = core.get_translator("mc_mobs")
local mob_class = mcl_mobs.mob_class
local storage = core.get_mod_storage()
local BEE = "mc_mobs:bee"
local OWNER = "mc_mobs:bee_id"
local NEXT_DAY = "mc_mobs:bee_next_day"
local FLOWER_RADIUS = 5
local ARRIVAL_RADIUS = 0.75
local FLIGHT_TIMEOUT = 8
local CHASE_RADIUS = 10
local CHASE_SECONDS = 8
local NORMAL_TEXTURES = { "mc_mobs_bee.png" }
local ANGRY_TEXTURES = { "mc_mobs_bee_angry.png" }

local circle = {
	vector.new(1, 0, 1), vector.new(-1, 0, 1),
	vector.new(-1, 0, -1), vector.new(1, 0, -1),
}

local function foraging_weather()
	local time = core.get_timeofday()
	return time >= 0.25 and time < 0.75 and mcl_weather.get_weather() == "none"
end

local function entrance(pos, node)
	-- facedir points out of the back of the node.
	return vector.subtract(pos, core.facedir_to_dir(node.param2))
end

local function is_air(pos)
	return core.get_node(pos).name == "air"
end

local function stop_flying(self)
	self:cancel_navigation()
	self:halt_in_tracks(true)
	self._acc_no_gravity = true
end

local function show_eyes(self, chasing)
	local textures = chasing and ANGRY_TEXTURES or NORMAL_TEXTURES
	if self._active_texture_list ~= textures then
		self:set_textures(textures)
	end
end

local function trip(self, phase, goal, seconds)
	stop_flying(self)
	self._bee_phase = phase
	self._bee_goal = goal
	self._bee_time = seconds or 0
end

local function fly_to(self, pos, goal)
	local distance = vector.distance(pos, goal)
	if distance <= ARRIVAL_RADIUS then
		return true
	end
	if self:navigation_finished() and self:check_timer("mc_bee_path", 0.5) then
		-- The pathfinder may finish at the edge of the destination node.
		if distance < 1.5 and core.line_of_sight(pos, goal) then
			self:go_to_pos(goal)
		else
			self:gopath(goal)
		end
	end
	return false
end

local function flower_goal(home)
	local flowers = core.find_nodes_in_area(vector.subtract(home, FLOWER_RADIUS),
		vector.add(home, FLOWER_RADIUS), { "group:flower" })
	local nearest, distance = nil, math.huge
	for _, flower in ipairs(flowers) do
		local d = vector.distance(home, flower)
		local above = vector.offset(flower, 0, 1, 0)
		if d <= FLOWER_RADIUS and d < distance and is_air(above) then
			nearest, distance = above, d
		end
	end
	return nearest
end

local function circle_nest(self, front)
	local center = vector.add(front, vector.subtract(front, self.bee_home))
	for _ = 1, #circle do
		self._bee_circle = (self._bee_circle or 0) % #circle + 1
		local goal = vector.add(center, circle[self._bee_circle])
		if is_air(goal) then
			trip(self, "circle", goal, FLIGHT_TIMEOUT)
			return
		end
	end
	trip(self, "return")
end

local function forage(self, front)
	local flower = flower_goal(self.bee_home)
	if flower then
		trip(self, "flower", flower, FLIGHT_TIMEOUT)
	else
		circle_nest(self, front)
	end
end

local function get_attacker(self, pos)
	local player = self._bee_attacker
	if player and player:is_valid() and self:attack_player_allowed(player)
		and core.get_gametime() < self._bee_chase_until
		and vector.distance(self.bee_home or pos, player:get_pos()) <= CHASE_RADIUS then
		return player
	end
	self._bee_attacker = nil
end

local function retaliate(self, hitter)
	if hitter and hitter:is_player() and self:attack_player_allowed(hitter) then
		if not self._bee_attacker then
			trip(self, "return")
		end
		self._bee_attacker = hitter
		self._bee_chase_until = core.get_gametime() + CHASE_SECONDS
	end
end

local function sting(self)
	mob_class.custom_attack(self)
	self._bee_attacker = nil
	trip(self, "return")
end

local function bee_ai(self, pos, dtime)
	local home = self.bee_home
	local node = home and core.get_node_or_nil(home)
	if home then
		if not node or node.name == "ignore" then
			show_eyes(self, false)
			trip(self, "return")
			return true
		end
		if core.get_item_group(node.name, "bee_nest") == 0
			or core.get_meta(home):get_int(OWNER) ~= self.bee_id then
			self:safe_remove()
			return true
		end
	end

	local was_attacking = self.attack ~= nil
	local attacking = self:check_attack(pos, dtime)
	show_eyes(self, self.attack ~= nil and self._bee_attacker ~= nil)
	if attacking then
		if was_attacking and not self.attack then
			trip(self, "return")
		end
		return true
	end
	if not home then
		-- Bees from the prototype and the /bee preview have no nest.
		return mob_class.check_pace(self, pos, dtime)
	end

	local front = entrance(home, node)
	local working = foraging_weather()
	local phase = self._bee_phase
	if not working and phase ~= "return" and phase ~= "rest" then
		trip(self, "return")
		phase = "return"
	end

	self._bee_time = self._bee_time - dtime
	if phase == "return" then
		if not is_air(front) then
			stop_flying(self)
		elseif fly_to(self, pos, front) then
			trip(self, "rest", nil, 2)
		end
	elseif phase == "rest" then
		if not is_air(front) or vector.distance(pos, front) > ARRIVAL_RADIUS then
			trip(self, "return")
		elseif working and self._bee_time <= 0 then
			forage(self, front)
		end
	elseif phase == "visit" then
		if self._bee_time <= 0 then
			trip(self, "return")
		end
	else
		local goal = self._bee_goal
		if not is_air(goal) or self._bee_time <= 0 then
			if phase == "flower" then
				circle_nest(self, front)
			else
				trip(self, "return")
			end
		elseif fly_to(self, pos, goal) then
			if phase == "flower" then
				trip(self, "visit", nil, 2)
			else
				forage(self, front)
			end
		end
	end
	return true
end

local function release_nest(self)
	local home = self.bee_home
	if not home then return end
	local node = core.get_node_or_nil(home)
	if not node or node.name == "ignore" then
		core.load_area(home)
		node = core.get_node_or_nil(home)
	end
	if node and core.get_item_group(node.name, "bee_nest") > 0 then
		local meta = core.get_meta(home)
		if meta:get_int(OWNER) == self.bee_id then
			meta:set_int(NEXT_DAY, core.get_day_count() + 1)
			meta:set_int(OWNER, 0)
		end
	end
end

local bee = {
	description = S("Bee"),
	type = "animal",
	_spawn_category = "creature",
	hp_min = 10,
	hp_max = 10,
	xp_min = 1,
	xp_max = 3,
	collisionbox = { -0.22, 0.0, -0.22, 0.22, 0.45, 0.22 },
	visual = "mesh",
	mesh = "mc_mobs_bee.glb",
	textures = NORMAL_TEXTURES,
	rotate = 180, -- The glTF front becomes -Z in Luanti; the mob moves along +Z at yaw 0.
	-- The wings beat continuously, including when the bee hovers.
	animation = { stand_start = 0, stand_end = 0.16, stand_speed = 1 },
	sounds = {
		random = "mc_bee_idle",
		damage = "mc_bee_hurt",
		death = "mc_bee_death",
		distance = 12,
	},
	can_despawn = false,
	airborne = true,
	airborne_speed = 6,
	_hovers = true,
	fall_damage = 0,
	movement_speed = 4,
	makes_footstep_sound = false,
	attack_type = "melee",
	reach = 2,
	damage = 2,
	pursuit_bonus = 1.25,
	ai_functions = { bee_ai },
	do_punch = retaliate,
	get_active_target = get_attacker,
	custom_attack = sting,
	after_activate = function(self)
		-- Saved bees may still carry the old cube's six textures and visual size.
		self.base_texture = NORMAL_TEXTURES
		self.base_mesh = self.initial_properties.mesh
		self.base_size = self.initial_properties.visual_size
		show_eyes(self, false)
		trip(self, "return")
	end,
	on_die = release_nest,
	on_deactivate = function(self, removal)
		-- Unloading keeps the resident. Only permanent removal frees the nest.
		if removal and not self.dead then
			release_nest(self)
		end
		mob_class.on_deactivate(self, removal)
	end,
}

mcl_mobs.register_mob(BEE, bee)
mcl_mobs.register_egg(BEE, S("Bee Spawn Egg"), "#edc343", "#43241b", 0)

core.register_abm({
	label = "方块世界：蜂巢住蜂",
	nodenames = { "group:bee_nest" },
	interval = 5,
	chance = 1,
	catch_up = false,
	action = function(pos, node)
		if not foraging_weather() then return end
		local meta = core.get_meta(pos)
		if meta:get_int(OWNER) ~= 0 or core.get_day_count() < meta:get_int(NEXT_DAY) then return end
		local front = entrance(pos, node)
		if not is_air(front) then return end

		-- A newly placed nest gets a new ID, even if it replaced one at the same position.
		local id = storage:get_int("last_bee_id") + 1
		storage:set_int("last_bee_id", id)
		meta:set_int(OWNER, id)
		if not core.add_entity(front, BEE, core.serialize({ bee_home = pos, bee_id = id })) then
			meta:set_int(OWNER, 0)
		end
	end,
})

core.register_chatcommand("bee", {
	description = "在身边放一只蜜蜂（试玩用）",
	func = function(name)
		local player = core.get_player_by_name(name)
		if not player then return false, "需要先进入世界" end
		local pos = player:get_pos()
		local ok = core.add_entity(vector.offset(pos, 1, 1.2, 1), BEE)
		return ok ~= nil, ok and "蜜蜂已生成" or "生成失败"
	end,
})
