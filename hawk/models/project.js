module.exports = function () {
  let mongo = require('../modules/database');
  let collections = require('../config/collections');
  let Crypto = require('crypto');

  const NOTIFICATION_PREFERENCES_FIELD = 'notifies';
  const WEBHOOK_FIELDS ='Hook';

  /**
   * Generate sha256 hash from member id and project id
   *
   * @param {String} memberId
   * @param {String} projectId
   * @returns {String} hash
   */
  let generateInviteHash = function (memberId, projectId) {
    let string = memberId + process.env.SALT + projectId;

    return Crypto.createHash('sha256').update(string, 'utf8').digest('hex');
  };

  /**
   * Get list of all projects
   *
   * @returns {*}
   */
  let getAll = () => {
    return mongo.find(collections.PROJECTS, {});
  };


  /**
   * Get user projects by userId
   *
   * @param {String} userId
   * @returns {Promise.<TResult>}
   */
  let getByUser = function (userId) {
    let userCollection = collections.MEMBERSHIP + ':' + userId;

    return mongo.aggregation(userCollection, [
      {$lookup: {
        from: collections.PROJECTS,
        localField: 'project_id',
        foreignField: '_id',
        as: 'project'
      }},
      {$unwind: '$project'},
      {$project: {
        id: '$project_id',
        name: '$project.name',
        description: '$project.description',
        uri: '$project_uri',
        logo: '$project.logo',
        domain: '$project.domain',
        token: '$project.token',
      }}
    ])
      .then(function (projects) {
        let queries = [];
        for (let i = 0; i < projects.length; i++) {
          queries.push(
            getTeam(projects[i].id)
              .then(function (team) {
                projects[i].team = team;
              })
          );

          queries.push(
            getUserData(projects[i].id, userId)
              .then(function (userData) {
                projects[i].user = userData;
              })
          );
        }

        return Promise.all(queries)
          .then(function () {
            return projects.filter(function (project) {
              return !project.user.is_pending;
            });
          });
      });
  };

  /**
   * Add member to the project
   *
   * @param {String} projectId
   * @param {String} projectUri
   * @param {String} userId (optional)
   * @param {Boolean} isOwner (optional) if true, user will be added with
   * admin access
   * @param {String} email - (optional) save email for invited users
   *
   * @returns {Promise.<TResult>}
   */
  let addMember = async (projectId, projectUri, userId = null, isOwner = false, email = null) => {
    let role = isOwner ? 'admin' : 'member',
        projectCollection = collections.TEAM + ':' + projectId;

    let teamParams = {
      email: email,
      user_id: userId,
      role: role,
      is_pending: !isOwner
    };

    return await mongo.insertOne(projectCollection, teamParams);
  };

  /**
   * Add new project to the database
   *
   * @param {Object} data.user
   * @param {String} data.name
   * @param {String} data.description
   * @param {String} data.domain
   * @param {Date} data.dt_added
   * @param {String} data.uid_added
   * @param {String} data.uri
   * @param {String} data.token
   * @param {String} data.logo
   *
   * @returns {Request|Promise.<TResult>}
   */
  let add = function (data) {
    return mongo.insertOne(collections.PROJECTS, data)
      .then(async function (result) {
        let insertedProject = result.ops[0];

        let user = data.user;

        await addMember(insertedProject._id, insertedProject.uri, user._id, true);

        await addProjectToUserProjects(user._id, insertedProject._id);

        return insertedProject;
      });
  };

  /**
   * Get project by project id. Also write project team to the team property
   *
   * @param {String} id
   * @returns {Promise.<TResult>}
   */
  let get = function (id) {
    let project;

    return mongo.findOne(collections.PROJECTS, {
      _id: mongo.ObjectId(id)
    })
      .then(function (project_) {
        project = project_;

        return getTeam(project._id);
      })
      .then(function (team) {
        project.team = team;
        return project;
      });
  };

  /**
   * Save project notifications for user with userId
   *
   * @param {String} projectId
   * @param {String} userId
   * @param {String} type - notification type (email|tg|slack)
   * @param {Boolean} value - enable or disable notifications (true|false)
   */
  let editNotifies = function (projectId, userId, type, value) {
    let userCollection = collections.MEMBERSHIP + ':' + userId,
        field = NOTIFICATION_PREFERENCES_FIELD + '.' + type;

    return mongo.updateOne(userCollection,
      {project_id: mongo.ObjectId(projectId)},
      {
        $set: {[field]: value}
      });
  };

  /**
   * Save webhook for project notofications for user with userId
   *
   * @param {String} projectId
   * @param {String} userId
   * @param {String} type - type of notifications (tg|slack)
   * @param {String} value - url for webhook
   */
  let saveWebhook = function (projectId, userId, type, value) {
    let userCollection = collections.MEMBERSHIP + ':' + userId,
        field = type+WEBHOOK_FIELDS;

    return mongo.updateOne(userCollection,
      {project_id: mongo.ObjectId(projectId)},
      {$set: {[field]: value}});
  };

  /**
   * Get project team by project id
   *
   * @param projectId
   * @returns {Promise.<TResult>}
   */
  let getTeam = function (projectId) {
    let projectCollection = collections.TEAM + ':' + projectId;

    return mongo.aggregation(projectCollection, [
      {
        $lookup: {
          from: collections.USERS,
          localField: 'user_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        "$unwind": {
          path: "$user",
          "preserveNullAndEmptyArrays": true
        }
      },
      {
        $project: {
          id: '$user_id',
          role: 1,
          is_pending: 1,
          notifies: 1,
          tgHook: 1,
          slackHook: 1,
          email: {
            $cond: [ { $not: ['$user.email'] }, '$email', '$user.email' ]
          }
        }
      }
    ]);
  };

  /**
   * Set is_pending field to false for user with userId in project team collection
   *
   * @param {String} projectId
   * @param {String} memberId
   * @param {String} userId
   */
  let confirmInvitation = function (projectId, memberId, userId) {
    let projectCollection = collections.TEAM + ':' + projectId;

    let query = {
      _id: mongo.ObjectId(memberId),

      /** If user_id is not null then invitation link was used once */
      user_id: null
    };

    let data = {
      $set: {
        user_id: mongo.ObjectId(userId),
        is_pending: false
      }
    };

    return mongo.updateOne(projectCollection, query, data)
      .then(function () {
        return get(projectId);
      });
  };

  /**
   * Set user's role to admin
   *
   * @param {String} projectId
   * @param {String} userId
   * @returns {Promise.<TResult>|Request}
   */
  let grantAdminAccess = function (projectId, userId) {
    let projectCollection = collections.TEAM + ':' + projectId;

    return mongo.updateOne(projectCollection, {user_id: mongo.ObjectId(userId)}, {$set: {role: 'admin'}});
  };

  /**
   * Get user info in project with projectId
   *
   * @param {String} projectId
   * @param {String} userId
   */
  let getUserData = function (projectId, userId) {
    let userCollection = collections.MEMBERSHIP + ':' + userId,
        projectCollection = collections.TEAM + ':' + projectId;

    return mongo.findOne(projectCollection, {user_id: mongo.ObjectId(userId)})
      .then(function (userData) {
        return mongo.findOne(userCollection, {project_id: mongo.ObjectId(projectId)})
          .then(function (projectData) {
            userData.projectUri = projectData.project_uri;
            userData.userId = userId;
            userData.notifies = projectData.notifies;
            userData.tgHook = projectData.tgHook;
            userData.slackHook = projectData.slackHook;
            return userData;
          });
      });
  };

  /**
   * Get unique project uri for user with userId
   *
   * @param {String} userId
   * @param {String} uri
   * @returns {Request|Promise.<TResult>}
   */
  let getProjectUriByUser = function (userId, uri) {
    let userCollection = collections.MEMBERSHIP + ':' + userId,
        regexp = new RegExp('^' + uri + '(-[0-9]+)?$', 'i');

    return mongo.find(userCollection, {'project_uri': {$regex: regexp}})
      .then(function (result) {
        let index = result.length !== 0 ? '-' + result.length : '';

        return uri + index;
      });
  };

  let getByToken = function (token) {
    return mongo.findOne(collections.PROJECTS, {token: token});
  };

  /**
   * Updates Project's logo URL
   *
   * @param {String} projectId - Project's id
   * @param {String} logoPath  - Logo file URL
   * @returns {Promise.<TResult>|Request}
   */
  let setIcon = function (projectId, logoPath) {
    return mongo.updateOne(collections.PROJECTS, {_id: mongo.ObjectId(projectId)}, {$set:{logo: logoPath}});
  };

  /**
   * Add project to user's projects list
   *
   * @param {String} userId
   * @param {String} projectId
   *
   * @return {Promise<*>}
   */
  let addProjectToUserProjects = async (userId, projectId) => {
    let userCollection = collections.MEMBERSHIP + ':' + userId;

    let membershipParams = {
      project_id: mongo.ObjectId(projectId),
      notifies: {
        email: true,
        tg: false,
        slack: false
      }
    };

    return await mongo.insertOne(userCollection, membershipParams);
  };

  /**
   * Check if user in project's team
   *
   * @param {String} userId
   * @param {String} projectId
   * @return {Boolean}
   */
  let checkMembership = async (userId, projectId) => {
    let userCollection = collections.MEMBERSHIP + ':' + userId;

    let foundProject = await mongo.find(userCollection, {project_id: mongo.ObjectId(projectId)}, null, 1);

    return !!foundProject.length;
  };

  return {
    addProjectToUserProjects,
    checkMembership,
    add,
    get,
    getAll,
    getByUser,
    getByToken,
    addMember,
    editNotifies,
    saveWebhook,
    getTeam,
    generateInviteHash,
    confirmInvitation,
    grantAdminAccess,
    getUserData,
    setIcon
  };
}();
