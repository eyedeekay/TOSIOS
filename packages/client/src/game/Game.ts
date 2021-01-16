import { Application, Container, Graphics, SCALE_MODES, settings, utils } from 'pixi.js';
import { BulletsManager, MonstersManager, PlayersManager, PropsManager } from './managers';
import { Constants, Geometry, Maps, Maths, Models, Types } from '@tosios/common';
import { DungeonMap, generate } from '@halftheopposite/dungeon';
import { Game, Monster, Player, Prop } from './entities';
import { ImpactConfig, ImpactTexture } from './assets/particles';
import { Emitter } from 'pixi-particles';
import { GUITextures } from './assets/images';
import { Inputs } from './utils/inputs';
import { Viewport } from 'pixi-viewport';
import { distanceBetween } from './utils/distance';

// We don't want to scale textures linearly because they would appear blurry.
settings.SCALE_MODE = SCALE_MODES.NEAREST;
settings.ROUND_PIXELS = true;

const ZINDEXES = {
    GROUND: 1,
    PROPS: 2,
    PARTICLES: 3,
    PLAYERS: 4,
    ME: 5,
    MONSTERS: 6,
    BULLETS: 7,
};

// TODO: These two constants should be calculated automatically.
// They are used to interpolate movements of other players for smoothness.
const TOREMOVE_MAX_FPS_MS = 1000 / 60;
const TOREMOVE_AVG_LAG = 50;

export interface Stats {
    state: Types.GameState;
    stateEndsAt: number;
    roomName?: string;
    playerName: string;
    playerLives: number;
    playerMaxLives: number;
    players: Models.PlayerJSON[];
    playersCount: number;
    playersMaxCount: number;
}

export interface IGameState {
    screenWidth: number;
    screenHeight: number;
    onActionSend: (action: Models.ActionJSON) => void;
}

/**
 * The main entrypoint for the game logic on the client-side.
 */
export class GameState {
    //
    // Sync fields
    //
    private game: Game;

    //
    // Local fields
    //
    private app: Application;

    private viewport: Viewport;

    private tilesContainer: Container;

    private particlesContainer: Container;

    private playersManager: PlayersManager;

    private monstersManager: MonstersManager;

    private propsManager: PropsManager;

    private bulletsManager: BulletsManager;

    private onActionSend: (action: Models.ActionJSON) => void;

    private me: Player | null;

    private moveActions: Models.ActionJSON[];

    private inputs: Inputs;

    private map: DungeonMap;

    //
    // Lifecycle
    //
    constructor(attributes: IGameState) {
        this.game = new Game({
            state: 'lobby',
            stateEndsAt: 0,
            roomName: '',
            maxPlayers: 0,
        });

        // App
        this.app = new Application({
            width: attributes.screenWidth,
            height: attributes.screenHeight,
            antialias: false,
            backgroundColor: utils.string2hex(Constants.BACKGROUND_COLOR),
            autoDensity: true,
            resolution: window.devicePixelRatio,
        });

        // Cursor
        const defaultIcon = `url('${GUITextures.crosshairIco}') 32 32, auto`;
        this.app.renderer.plugins.interaction.cursor = 'default';
        this.app.renderer.plugins.interaction.cursorStyles.default = defaultIcon;

        // Viewport
        this.viewport = new Viewport({
            screenWidth: attributes.screenWidth,
            screenHeight: attributes.screenHeight,
        });
        this.viewport.zoomPercent(utils.isMobile.any ? 0.25 : 1.0);
        this.viewport.sortableChildren = true;
        this.app.stage.addChild(this.viewport);

        // Tiles
        this.tilesContainer = new Container();
        this.tilesContainer.zIndex = ZINDEXES.GROUND;
        this.viewport.addChild(this.tilesContainer);

        // Particles
        this.particlesContainer = new Container();
        this.particlesContainer.zIndex = ZINDEXES.PARTICLES;
        this.viewport.addChild(this.particlesContainer);

        // Players
        this.playersManager = new PlayersManager();
        this.playersManager.zIndex = ZINDEXES.PLAYERS;
        this.viewport.addChild(this.playersManager);

        // Monsters
        this.monstersManager = new MonstersManager();
        this.monstersManager.zIndex = ZINDEXES.MONSTERS;
        this.viewport.addChild(this.monstersManager);

        // Props
        this.propsManager = new PropsManager();
        this.propsManager.zIndex = ZINDEXES.PROPS;
        this.viewport.addChild(this.propsManager);

        // Bullets
        this.bulletsManager = new BulletsManager();
        this.bulletsManager.zIndex = ZINDEXES.BULLETS;
        this.viewport.addChild(this.bulletsManager);

        // Callbacks
        this.onActionSend = attributes.onActionSend;

        //
        // Others
        //
        this.me = null;
        this.moveActions = [];
        this.inputs = new Inputs();
        this.map = new DungeonMap(Constants.TILE_SIZE);
    }

    start = (renderView: any) => {
        renderView.appendChild(this.app.view);
        this.app.start();
        this.app.ticker.add(this.update);
        this.inputs.start();
    };

    private update = () => {
        this.updateInputs();
        this.updatePlayers();
        this.updateMonsters();
        this.updateBullets();

        this.playersManager.sortChildren();
    };

    private updateInputs = () => {
        // Move
        const dir = new Geometry.Vector2(0, 0);
        if (this.inputs.up || this.inputs.down || this.inputs.left || this.inputs.right) {
            if (this.inputs.up) {
                dir.y -= 1;
            }

            if (this.inputs.down) {
                dir.y += 1;
            }

            if (this.inputs.left) {
                dir.x -= 1;
            }

            if (this.inputs.right) {
                dir.x += 1;
            }

            if (!dir.empty) {
                this.move(dir);
            }
        }

        // Rotate
        this.rotate();

        // Shoot
        if (this.inputs.shoot) {
            this.shoot();
        }
    };

    private updatePlayers = () => {
        let distance;

        for (const player of this.playersManager.getAll()) {
            distance = Maths.getDistance(player.x, player.y, player.toX, player.toY);
            if (distance > 0.01) {
                player.setPosition(
                    Maths.lerp(player.x, player.toX, TOREMOVE_MAX_FPS_MS / TOREMOVE_AVG_LAG),
                    Maths.lerp(player.y, player.toY, TOREMOVE_MAX_FPS_MS / TOREMOVE_AVG_LAG),
                );
            }
        }
    };

    private updateMonsters = () => {
        let distance;

        for (const monster of this.monstersManager.getAll()) {
            distance = Maths.getDistance(monster.x, monster.y, monster.toX, monster.toY);
            if (distance > 0.01) {
                monster.x = Maths.lerp(monster.x, monster.toX, TOREMOVE_MAX_FPS_MS / TOREMOVE_AVG_LAG);
                monster.y = Maths.lerp(monster.y, monster.toY, TOREMOVE_MAX_FPS_MS / TOREMOVE_AVG_LAG);
            }
        }
    };

    private updateBullets = () => {
        for (const bullet of this.bulletsManager.getAll()) {
            if (!bullet.active) {
                continue;
            }

            bullet.move(Constants.BULLET_SPEED);

            //
            // Collisions: Players
            //
            // for (const player of this.playersManager.getAll()) {
            //     // Check if the bullet can hurt the player
            //     if (!player.canBulletHurt(bullet.playerId) || !Collisions.circleToCircle(bullet.body, player.body)) {
            //         continue;
            //     }

            //     bullet.kill(distanceBetween(this.me?.body, bullet.body));
            //     player.hurt();
            //     this.spawnImpact(bullet.x, bullet.y);
            //     continue;
            // }

            //
            // Collisions: Me
            //
            // if (
            //     this.me &&
            //     this.me.canBulletHurt(bullet.playerId) &&
            //     this.me.lives &&
            //     Collisions.circleToCircle(bullet.body, this.me.body)
            // ) {
            //     bullet.kill(distanceBetween(this.me?.body, bullet.body));
            //     this.me.hurt();
            //     this.spawnImpact(bullet.x, bullet.y);
            //     continue;
            // }

            //
            // Collisions: Monsters
            //
            const collidingMonsters = this.map.collidesByLayer(bullet.id, 'monsters');
            if (collidingMonsters.length > 0) {
                const firstMonster = collidingMonsters[0];
                bullet.kill(distanceBetween(this.me?.body, bullet.body));
                this.monstersManager.get(firstMonster.id)?.hurt();
                this.spawnImpact(bullet.x, bullet.y);
                continue;
            }

            //
            // Collisions: Walls
            //
            const collidingWalls = this.map.collidesByLayer(bullet.id, 'tiles');
            if (collidingWalls.length > 0) {
                bullet.kill(distanceBetween(this.me?.body, bullet.body));
                this.spawnImpact(bullet.x, bullet.y);
                continue;
            }
        }
    };

    stop = () => {
        this.app.ticker.stop();
        this.app.stop();
        this.inputs.stop();
    };

    //
    // Actions
    //
    private move = (dir: Geometry.Vector2) => {
        if (!this.me) {
            return;
        }

        const action: Models.ActionJSON = {
            type: 'move',
            ts: Date.now(),
            playerId: this.me.id,
            value: {
                x: dir.x,
                y: dir.y,
            },
        };

        // Send the action to the server
        this.onActionSend(action);

        // Save the action for reconciliation
        this.moveActions.push(action);

        // Actually move the player
        this.me.move(dir.x, dir.y, Constants.PLAYER_SPEED);

        // Collisions: Walls
        // const correctedPosition = this.walls.correctWithCircle(this.me.body);
        // this.me.x = correctedPosition.x;
        // this.me.y = correctedPosition.y;
    };

    private rotate = () => {
        if (!this.me) {
            return;
        }

        // On desktop we compute rotation with player and mouse position
        const screenPlayerPosition = this.viewport.toScreen(this.me.x, this.me.y);
        const mouse = this.app.renderer.plugins.interaction.mouse.global;
        const rotation = Maths.round2Digits(
            Maths.calculateAngle(mouse.x, mouse.y, screenPlayerPosition.x, screenPlayerPosition.y),
        );

        if (this.me.rotation !== rotation) {
            this.me.rotation = rotation;
            this.onActionSend({
                type: 'rotate',
                ts: Date.now(),
                playerId: this.me.id,
                value: {
                    rotation,
                },
            });
        }
    };

    private shoot = () => {
        if (!this.me || this.game.state !== 'game' || !this.me.canShoot()) {
            return;
        }

        const bulletX = this.me.x + Math.cos(this.me.rotation) * Constants.PLAYER_WEAPON_SIZE;
        const bulletY = this.me.y + Math.sin(this.me.rotation) * Constants.PLAYER_WEAPON_SIZE;

        this.me.lastShootAt = Date.now();

        // this.bulletsManager.addOrCreate(
        //     {
        //         id:
        //         x: bulletX,
        //         y: bulletY,
        //         radius: Constants.BULLET_SIZE,
        //         rotation: this.me.rotation,
        //         active: true,
        //         fromX: bulletX,
        //         fromY: bulletY,
        //         playerId: this.me.playerId,
        //         shotAt: this.me.lastShootAt,
        //     },
        //     this.particlesContainer,
        // );
        this.onActionSend({
            type: 'shoot',
            ts: Date.now(),
            playerId: this.me.id,
            value: {
                angle: this.me.rotation,
            },
        });
    };

    //
    // Game
    //
    resetGame = () => {
        if (!this.game.seed) {
            return;
        }

        // Reset current states
        this.map.clearDungeon();
        this.tilesContainer.removeChildren();

        // 1. Create dungeon
        const dungeon = generate({
            ...Maps.DEFAULT_DUNGEON,
            seed: this.game.seed,
        });
        this.map.loadDungeon(dungeon);

        for (let y = 0; y < dungeon.layers.tiles.length; y++) {
            for (let x = 0; x < dungeon.layers.tiles[y].length; x++) {
                const id = dungeon.layers.tiles[y][x];

                const rectangle = new Graphics();
                rectangle.beginFill(id > 0 ? 0xff0000 : 0x00ff00);
                rectangle.drawRect(0, 0, Constants.TILE_SIZE, Constants.TILE_SIZE);
                rectangle.endFill();
                rectangle.position.set(x * Constants.TILE_SIZE, y * Constants.TILE_SIZE);
                this.tilesContainer.addChild(rectangle);
            }
        }
    };

    gameUpdate = (name: string, value: any) => {
        switch (name) {
            case 'state':
                this.game.state = value;
                break;
            case 'stateEndsAt':
                this.game.stateEndsAt = value;
                break;
            case 'roomName':
                this.game.roomName = value;
                break;
            case 'maxPlayers':
                this.game.maxPlayers = value;
                break;
            case 'seed':
                this.game.seed = value;
                this.resetGame();
                break;
            default:
                break;
        }
    };

    //
    // Players
    //
    playerAdd = (playerId: string, attributes: Models.PlayerJSON, isMe: boolean) => {
        const player = new Player(attributes, isMe, this.particlesContainer);
        this.playersManager.add(playerId, player);

        // If the player is "you"
        if (isMe) {
            this.me = new Player(attributes, false, this.particlesContainer);

            this.playersManager.addChild(this.me.container);
            this.viewport.follow(this.me.container);
        }
    };

    playerUpdate = (playerId: string, attributes: Models.PlayerJSON, isMe: boolean) => {
        if (isMe && this.me) {
            const ghost = this.playersManager.get(playerId);
            if (!ghost) {
                return;
            }

            // Update base
            this.me.lives = attributes.lives;
            this.me.maxLives = attributes.maxLives;
            this.me.kills = attributes.kills;

            if (attributes.ack !== this.me.ack) {
                this.me.ack = attributes.ack;

                // Update ghost position
                ghost.x = attributes.x;
                ghost.y = attributes.y;
                ghost.toX = attributes.x;
                ghost.toY = attributes.y;

                // Run simulation of all movements that weren't treated by server yet
                const index = this.moveActions.findIndex((action) => action.ts === attributes.ack);
                this.moveActions = this.moveActions.slice(index + 1);
                this.moveActions.forEach((action) => {
                    const updatedPosition = Models.movePlayer(
                        ghost.x,
                        ghost.y,
                        ghost.body.radius,
                        action.value.x,
                        action.value.y,
                        Constants.PLAYER_SPEED,
                        // this.map,
                        null as any, // TODO: Pass a real map
                    );

                    ghost.x = updatedPosition.x;
                    ghost.y = updatedPosition.y;
                    ghost.toX = updatedPosition.x;
                    ghost.toY = updatedPosition.y;
                });

                // Check if our predictions were accurate
                const distance = Maths.getDistance(this.me.x, this.me.y, ghost.x, ghost.y);
                if (distance > 0) {
                    this.me.setPosition(ghost.x, ghost.y);
                }
            }
        } else {
            const player = this.playersManager.get(playerId);
            if (!player) {
                return;
            }

            // Update base
            player.lives = attributes.lives;
            player.maxLives = attributes.maxLives;
            player.kills = attributes.kills;

            // Update rotation
            player.rotation = attributes.rotation;

            // Update position
            player.setPosition(player.toX, player.toY);
            player.toX = attributes.x;
            player.toY = attributes.y;
        }
    };

    playerRemove = (playerId: string, isMe: boolean) => {
        this.playersManager.remove(playerId);

        // If the player is "you"
        if (isMe && this.me) {
            this.playersManager.removeChild(this.me.container);
            this.me = null;
        }
    };

    //
    // Monsters
    //
    monsterAdd = (monsterId: string, attributes: Models.MonsterJSON) => {
        const monster = new Monster(attributes);
        this.monstersManager.add(monsterId, monster);
    };

    monsterUpdate = (monsterId: string, attributes: Models.MonsterJSON) => {
        const monster = this.monstersManager.get(monsterId);
        if (!monster) {
            return;
        }

        monster.rotation = attributes.rotation;

        // Set new interpolation values
        monster.x = monster.toX;
        monster.y = monster.toY;
        monster.toX = attributes.x;
        monster.toY = attributes.y;
    };

    monsterRemove = (monsterId: string) => {
        this.monstersManager.remove(monsterId);
    };

    //
    // Props
    //
    propAdd = (propId: string, attributes: Models.PropJSON) => {
        const prop = new Prop(attributes);
        this.propsManager.add(propId, prop);
    };

    propUpdate = (propId: string, attributes: Models.PropJSON) => {
        const prop = this.propsManager.get(propId);
        if (!prop) {
            return;
        }

        prop.x = attributes.x;
        prop.y = attributes.y;
        prop.active = attributes.active;
    };

    propRemove = (propId: string) => {
        this.propsManager.remove(propId);
    };

    //
    // Bullets
    //
    bulletAdd = (bulletId: string, attributes: Models.BulletJSON) => {
        if ((this.me && this.me.id === attributes.playerId) || !attributes.active) {
            return;
        }

        this.bulletsManager.addOrCreate(attributes, this.particlesContainer);
    };

    bulletRemove = (bulletId: string) => {
        this.bulletsManager.remove(bulletId);
    };

    //
    // Utils
    //
    private spawnImpact = (x: number, y: number, color = '#ffffff') => {
        new Emitter(this.playersManager, [ImpactTexture], {
            ...ImpactConfig,
            color: {
                start: color,
                end: color,
            },
            pos: {
                x,
                y,
            },
        }).playOnceAndDestroy();
    };

    setScreenSize = (screenWidth: number, screenHeight: number) => {
        this.app.renderer.resize(screenWidth, screenHeight);
        this.viewport.resize(
            screenWidth,
            screenHeight,
            this.map.width * Constants.TILE_SIZE,
            this.map.height * Constants.TILE_SIZE,
        );
    };

    getStats = (): Stats => {
        const players: Models.PlayerJSON[] = this.playersManager.getAll().map((player) => ({
            id: player.id,
            x: player.x,
            y: player.y,
            radius: player.body.radius,
            rotation: player.rotation,
            name: player.name,
            lives: player.lives,
            maxLives: player.maxLives,
            kills: player.kills,
        }));

        return {
            state: this.game.state,
            stateEndsAt: this.game.stateEndsAt,
            roomName: this.game.roomName,
            playerName: this.me ? this.me.name : '',
            playerLives: this.me ? this.me.lives : 0,
            playerMaxLives: this.me ? this.me.maxLives : 0,
            players,
            playersCount: players.length,
            playersMaxCount: this.game.maxPlayers,
        };
    };
}
