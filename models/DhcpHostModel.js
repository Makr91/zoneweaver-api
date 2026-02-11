import { Sequelize } from 'sequelize';
import db from '../config/Database.js';

const { DataTypes } = Sequelize;

const DhcpHosts = db.define(
  'dhcp_hosts',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    hostname: { type: DataTypes.STRING, allowNull: false, unique: true },
    mac: { type: DataTypes.STRING, allowNull: false, unique: true },
    ip: { type: DataTypes.STRING, allowNull: false, unique: true },
    description: { type: DataTypes.STRING },
    created_by: { type: DataTypes.STRING },
  },
  {
    freezeTableName: true,
    indexes: [
      {
        unique: true,
        fields: ['mac'],
      },
      {
        unique: true,
        fields: ['ip'],
      },
    ],
    comment: 'DHCP static host entries synchronized with /etc/dhcpd.conf',
  }
);

export default DhcpHosts;
