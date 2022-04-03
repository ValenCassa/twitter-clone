import { PubSub } from "graphql-subscriptions"
import models from '../../models/index.js'
import { UserInputError, AuthenticationError } from "apollo-server-express"
import bcrypt from 'bcrypt'
import { default as jwt } from 'jsonwebtoken'
import { Op } from "@sequelize/core"
import db from '../../utils/db.js'


const pubsub = new PubSub()

const SUBSCRIPTIONS = {
    fav: 'POST_FAVED',
    unFav: 'POST_UNFAVED'
}

const resolvers = {
    Query: {
        checkUser: async (root, args, context) => {
            const currentUser = context.currentUser()
            return currentUser
        },
        allTweets: async () => {
            // Subscription pubsub.publish('TWEETS_VIEWED', { tweetsViewed: tweets })
            const posts = await models.Post.findAll()
            return posts
        },
        findUser: async (root, args) => {
            const user = await models.User.findOne({
                where: {
                    username: args.user
                }
            })

            return user
        },
        checkUserFollowers: async (root, args) => {

            const getFollowers = await models.User.findByPk(args.user_id, {
                include: [
                    {
                        model: models.User,
                        as: 'followers_list',
                    },
                    {
                        model: models.User,
                        as: 'following_list',
                    }

                ]
            })

            

            const followersData = JSON.parse(JSON.stringify(getFollowers))

            return { followers: followersData.followers_list, following: followersData.following_list }
        },
        countUserFollowers: async (root, args) => {
            const getFollowings = await models.Followers.findAndCountAll({
                where: {
                    user_id: args.user_id
                },
            })

            const getFollowers = await models.Followers.findAndCountAll({
                where: {
                    follower_id: args.user_id
                }
            })

            const followers = JSON.parse(JSON.stringify(getFollowers)).count
            const followings = JSON.parse(JSON.stringify(getFollowings)).count
            
            return { followers, followings }

        },
        postFromFollowers: async (root, args, context) => {

            const currentUser = await context.currentUser()

            // Have to query this way because sequelize does not support EXISTS clause
            const posts = await db.sequelize.query(`
                SELECT posts.id, content, users.id AS user_id, username, created_at, updated_at FROM posts
                INNER JOIN users ON posts.user_id = users.id
                WHERE user_id = ${currentUser.id}
                OR EXISTS (SELECT * FROM followers WHERE follower_id = posts.user_id AND user_id = ${currentUser.id})
                `)

            
            return posts[0]
        },
        tweetsProfile: async (root, args) => {

            const posts = await db.sequelize.query(`
            SELECT posts.id, content, users.id AS user_id, username, created_at, updated_at FROM posts
            INNER JOIN users ON posts.user_id = users.id
            WHERE user_id = ${args.user_id}
            OR EXISTS (SELECT * FROM reposts WHERE reposts.post_id = posts.id AND user_id = ${args.user_id})
            `)

        
        return posts[0]
        },
        timeline: async (root, args, context) => {
            const currentUser = await context.currentUser()
            const posts = await db.sequelize.query(`
            SELECT posts.id, content, users.id AS user_id, users.username, created_at, updated_at, s.name AS reposted_by, s.user_id as reposted_id
            FROM posts
            INNER JOIN users ON posts.user_id = users.id
            FULL JOIN (select * from reposts full join users on users.id = reposts.user_id WHERE reposts.user_id = ${currentUser.id} OR EXISTS (SELECT * FROM followers WHERE follower_id = reposts.user_id AND followers.user_id = ${currentUser.id})) s on s.post_id = posts.id
            WHERE users.id = ${currentUser.id}
            OR EXISTS (SELECT * FROM followers WHERE follower_id = posts.user_id AND user_id = ${currentUser.id})
            ORDER BY created_at DESC
            `)

            return posts[0]
        },
        userFavs: async (root, args) => {
            const userFavs = await models.Post.findAll({
                include: {
                    model: models.Fav,
                    attributes: ['user_id', 'faved_at'],
                    where: {
                        user_id: args.user_id
                    }
                },
            })

            return userFavs
        },
        postComments: async (root, args) => {
            const postComments = await models.Post.findAll({
                where: {
                    reply_id: args.post_id
                }
            })

            return postComments
        },
        postData: async (root, args) => {
            const favsData = await models.Fav.findAll({
                where: {
                    post_id: args.post_id
                }
            })

            const repostsData = await models.RePost.findAll({
                where: {
                    post_id: args.post_id
                }
            })

            const favs = JSON.parse(JSON.stringify(favsData)).length
            const reposts = JSON.parse(JSON.stringify(repostsData)).length

            return { favs, reposts }
        }
    },

    Mutation: {
        registerUser: async (root, args) => {
            const saltRounds = 10

            if (args.password < 6) {
                throw new UserInputError('Password should be, at least, 6 characteres long', {
                    invalidArgs: args.password
                })
            }
            
            try {
                const passwordHash = await bcrypt.hash(args.password, saltRounds)
                const user = await models.User.create({ username: args.username, name: args.name, passwordHash})
                
                return user
                
            } catch (error) {
                throw new UserInputError(error.message, {
                    invalidArgs: args
                })
            }
        },
        createPost: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            try {
                const post = await models.Post.create({...args, user_id: currentUser.id })

                return post

            } catch (error) {
                throw new UserInputError(error.message, {
                    invalidArgs: args
                })
            } 

        },
        login: async (root, args) => {
            const user = await models.User.findOne({
                where: {
                    username: args.username
                }
            })

            const passwordCorrect = user === null
                ? false
                : await bcrypt.compare(args.password, user.passwordHash)

            if (!(user && passwordCorrect)) {
                throw new UserInputError('Wrong credentials', {
                    invalidArgs: args
                })
            }

            const userForToken = {
                username: user.username,
                id: user.id
            }

            const token = jwt.sign(
                userForToken,
                process.env.SECRET,
                { expiresIn: 60*60 }
            )

            return { value: token }

        },
        follow: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            try {
                await models.Followers.create({ user_id: currentUser.id, follower_id: args.follower_id })
                const userFollowed = await models.User.findByPk(args.follower_id)

                return userFollowed
            } catch (error) {
                throw new UserInputError(error.message, {
                    invalidArgs: args
                })
            }
        },
        unfollow: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            try {
                await models.Followers.destroy({
                    where: {
                        user_id: currentUser.id,
                        follower_id: args.follower_id
                    }
                })

                return 'Unfollowed Succesfully'
            } catch (error) {
                throw new UserInputError(error.message, {
                    invalidArgs: args
                })
            }
        },
        rePost: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            const exists = await models.RePost.findOne({
                where: {
                    [Op.and]: [
                        { 'user_id': currentUser.id },
                        { 'post_id': args.post_id }
                    ]
                }
            })

            if(exists) {
                throw new UserInputError('Post already reposted')
            }
            
            try {
                await models.RePost.create({ user_id: currentUser.id, post_id: args.post_id, reposted_at: new Date() })
                
                return 'Succefully reposted'
            } catch (error) {
                throw new UserInputError(error.message, {
                    invalidArgs: args
                })
            }
        },
        delRePost: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            try {
                await models.RePost.destroy({
                    where: {
                        user_id: currentUser.id,
                        post_id: args.post_id
                    }
                })

                return 'Removed repost successfully'
            } catch (error) {
                throw new UserInputError(error.message)
            }
        },
        fav: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            const exists = await models.Fav.findOne({
                where: {
                    [Op.and]: [
                        { user_id: currentUser.id },
                        { post_id: args.post_id }
                    ]
                }
            })

            
            if(exists) {
                throw new UserInputError('Post already faved')
            }

            try {
                const favedPost = await models.Fav.create({ user_id: currentUser.id, post_id: args.post_id, faved_at: new Date() })
                pubsub.publish(SUBSCRIPTIONS.fav, { liveFavs: favedPost })
                return 'Faved successfully'
            } catch (error) {
                throw new UserInputError(error.message)
            }
        },
        unFav: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            try {
                const unFavedPost = await models.Fav.findOne({
                    where: {
                        user_id: currentUser.id,
                        post_id: args.post_id
                    }
                })
                
                pubsub.publish(SUBSCRIPTIONS.unFav, { liveUnFav: unFavedPost })

                await models.Fav.destroy({
                    where: {
                        user_id: currentUser.id,
                        post_id: args.post_id
                    }
                })


                return 'Removed fav successfully'
            } catch (error) {
                throw new UserInputError(error.message)
            }
        },
        addComment: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            try {
                const comment = await models.Post.create({...args, user_id: currentUser.id })

                return comment
            } catch (error) {
                throw new UserInputError(error.message)
            }
        },
        delComment: async (root, args, context) => {
            const currentUser = await context.currentUser()

            if (!currentUser) {
                throw new AuthenticationError('Not authenticated')
            }

            try {
                await models.Post.destroy({
                    where: {
                        user_id: currentUser.id,
                        reply_id: args.reply_id
                    }
                })

                return 'Comment deleted successfully'
            } catch (error) {
                throw new UserInputError(error.message)
            }
        }
        
    },
    Subscription: {
        liveFavs: {
            subscribe: () => pubsub.asyncIterator([SUBSCRIPTIONS.fav])
        },
        liveUnFav: {
            subscribe: () => pubsub.asyncIterator([SUBSCRIPTIONS.unFav])
        }
    } 
}

export default resolvers