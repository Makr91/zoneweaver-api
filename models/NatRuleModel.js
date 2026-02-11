import { Sequelize } from 'sequelize';
import db from '../config/Database.js';

const { DataTypes } = Sequelize;

const NatRules = db.define(
  'nat_rules',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    bridge: { type: DataTypes.STRING, allowNull: false },
    subnet: { type: DataTypes.STRING, allowNull: false },
    target: { type: DataTypes.STRING, allowNull: false },
    protocol: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false }, // map, rdr, bimap
    raw_rule: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'The exact rule string as it appears in ipnat.conf',
    },
    description: { type: DataTypes.STRING },
    created_by: { type: DataTypes.STRING },
  },
  {
    freezeTableName: true,
    indexes: [
      {
        unique: true,
        fields: ['raw_rule'],
        name: 'unique_nat_rule',
      },
    ],
    comment: 'NAT rules synchronized with /etc/ipf/ipnat.conf',
  }
);

export default NatRules;
